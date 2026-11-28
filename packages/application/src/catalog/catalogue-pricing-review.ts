import { createHash } from 'node:crypto';
import { validatePricingPolicy, type PricingPolicy } from '../../../domain/src/index.js';
import { AdministrationError, administrationUuid, type AdministrationAuthority, type AdministrationLease } from '../administration/access.js';
import type { VerifiedStaffIdentity } from '../identity/verified-staff-identity.js';
import { financialPolicyRecord } from './publication-candidate.js';

export type CatalogueReviewKind = 'MAPPING' | 'POLICY';
export type CatalogueReviewCommand =
  | { readonly kind:'MAPPING'; readonly discoveryId:string; readonly productId:string; readonly termsDigest:string }
  | { readonly kind:'POLICY'; readonly policy:PricingPolicy };

export interface CatalogueReviewProposal {
  readonly id:string; readonly tenantId:string; readonly creatorId:string; readonly kind:CatalogueReviewKind;
  readonly scope:string; readonly version:number; readonly digest:string; readonly payload:string;
}

export interface CatalogueReviewStore {
  append(lease:AdministrationLease, command: Readonly<{ id:string; kind:CatalogueReviewKind; scope:string;
    expectedVersion:number; digest:string; payload:string; discoveryId?:string; productId?:string }>):Promise<CatalogueReviewProposal>;
  decide(lease:AdministrationLease, command:Readonly<{ id:string; kind:CatalogueReviewKind;
    version:number; digest:string; decision:'APPROVED'|'REJECTED' }>):Promise<void>;
}

const digest = /^[a-f0-9]{64}$/;
const version = (value:number) => Number.isSafeInteger(value) && value > 0 && value <= 2_147_483_646;
export class CataloguePricingReviewService {
  constructor(private readonly authority:AdministrationAuthority, private readonly store:CatalogueReviewStore) {}

  async propose(identity:VerifiedStaffIdentity, tenantId:string, id:string, expectedVersion:number, command:CatalogueReviewCommand) {
    if (!administrationUuid.test(id) || (expectedVersion !== 0 && !version(expectedVersion))) throw new AdministrationError(400);
    const lease = await this.authority.require(identity, tenantId, command.kind==='MAPPING'?'catalog.mapping.propose':'pricing.draft');
    if (lease.tenantId!==tenantId || !await lease.revalidate()) throw new AdministrationError(403);
    let scope:string, payload:string;
    if (command.kind==='MAPPING') {
      if (!administrationUuid.test(command.discoveryId) || !administrationUuid.test(command.productId) || !digest.test(command.termsDigest)) {
        throw new AdministrationError(400);
      }
      scope=command.discoveryId;
      payload=JSON.stringify(['CATALOGUE_MAPPING_V1',tenantId,command.discoveryId,command.productId,command.termsDigest]);
    } else if (command.kind==='POLICY') {
      validatePricingPolicy(command.policy);
      if (!/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$/.test(command.policy.version)) throw new AdministrationError(400);
      scope='ARE_GIFT_CARD';
      payload=JSON.stringify(['AED_PRICING_POLICY_V1',tenantId,financialPolicyRecord(command.policy)]);
    } else throw new AdministrationError(400);
    return this.store.append(lease,Object.freeze({id,expectedVersion,kind:command.kind,scope,payload,
      digest:createHash('sha256').update(payload).digest('hex'),
      ...(command.kind==='MAPPING'&&{discoveryId:command.discoveryId,productId:command.productId})}));
  }

  async decide(identity:VerifiedStaffIdentity, tenantId:string, command:Parameters<CatalogueReviewStore['decide']>[1]) {
    if (!administrationUuid.test(command.id) || !version(command.version) || !digest.test(command.digest) ||
        !['MAPPING','POLICY'].includes(command.kind) || !['APPROVED','REJECTED'].includes(command.decision)) {
      throw new AdministrationError(400);
    }
    const lease=await this.authority.require(identity,tenantId,command.kind==='MAPPING'?'catalog.mapping.approve':'pricing.approve');
    if (lease.tenantId!==tenantId || !await lease.revalidate()) throw new AdministrationError(403);
    await this.store.decide(lease,Object.freeze({ ...command }));
    return Object.freeze({ decision:command.decision, effective:false });
  }
}
