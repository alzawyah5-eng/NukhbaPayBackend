/** Country/region identifiers checked against UN Statistics Division M49,
 * https://unstats.un.org/unsd/methodology/m49/overview/ on 2026-11-19.
 * Reference geography is NOT a declaration of service/provider availability. */
export const CATALOGUE_GEOGRAPHY_SOURCE='https://unstats.un.org/unsd/methodology/m49/overview/';
export const CATALOGUE_COUNTRIES=Object.freeze([
  ['AE','United Arab Emirates','Asia','GCC'],['BH','Bahrain','Asia','GCC'],['KW','Kuwait','Asia','GCC'],['OM','Oman','Asia','GCC'],['QA','Qatar','Asia','GCC'],['SA','Saudi Arabia','Asia','GCC'],
  ['BD','Bangladesh','Asia','OTHER_ASIA'],['IN','India','Asia','OTHER_ASIA'],['LK','Sri Lanka','Asia','OTHER_ASIA'],['NP','Nepal','Asia','OTHER_ASIA'],['PK','Pakistan','Asia','OTHER_ASIA'],['PH','Philippines','Asia','OTHER_ASIA'],
  ['EG','Egypt','Africa','AFRICA'],['GH','Ghana','Africa','AFRICA'],['KE','Kenya','Africa','AFRICA'],['MA','Morocco','Africa','AFRICA'],['NG','Nigeria','Africa','AFRICA'],['ZA','South Africa','Africa','AFRICA'],
  ['DE','Germany','Europe','EUROPE'],['ES','Spain','Europe','EUROPE'],['FR','France','Europe','EUROPE'],['GB','United Kingdom','Europe','EUROPE'],['IT','Italy','Europe','EUROPE'],
].map(([code,name,continent,group])=>Object.freeze({code:code!,name:name!,continent:continent!,group:group!})));
