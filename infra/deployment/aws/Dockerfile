FROM node:24.22.1-bookworm AS frontend
WORKDIR /frontend-source
COPY frontend/ ./
RUN npm ci && npm run typecheck && npm run build:staff && npm run build:kiosk

FROM node:24.22.1-bookworm AS staging
WORKDIR /app
RUN npm install --global pnpm@10.34.9
COPY backend/ ./
RUN pnpm install --frozen-lockfile && pnpm -r build
ADD https://truststore.pki.rds.amazonaws.com/eu-north-1/eu-north-1-bundle.pem /app/rds-ca.pem
COPY --from=frontend /frontend-source/dist-staff/ /app/staff-browser/
COPY --from=frontend /frontend-source/dist-kiosk/kiosk.html /app/kiosk/kiosk.html
COPY --from=frontend /frontend-source/dist-kiosk/kiosk-assets/ /app/kiosk/kiosk-assets/
COPY --from=frontend /frontend-source/dist-kiosk/kiosk-static/ /app/kiosk/kiosk-static/
ENV NODE_ENV=production NUKHBAPAY_ENVIRONMENT=aws-staging
USER node
EXPOSE 8080
CMD ["node", "scripts/start-aws-staging-staff.mjs"]
