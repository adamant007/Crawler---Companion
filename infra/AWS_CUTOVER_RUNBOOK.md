# AWS cutover runbook

This branch is intentionally isolated from the live Amplify branch. Do not merge
or set `VITE_BACKEND_PROVIDER=aws` until the backend stack is deployed and data
migration has been verified.

## What is already prepared

- Cognito email/password authentication
- Cognito hosted OAuth callback plumbing
- optional Google identity provider sourced from AWS Secrets Manager
- API Gateway HTTP API with Cognito authorization
- Lambda API for users, characters, campaigns, GM notes, sessions, and core
  campaign actions
- Aurora PostgreSQL Serverless v2 with Data API
- automatic versioned SQL migrations during CDK deployment
- private versioned S3 asset bucket
- early cost controls (Aurora max 1 ACU, API Lambda reserved concurrency 20,
  old S3 object versions expire after 30 days)
- frontend compatibility switch so existing components can move from Base44
  without an all-at-once rewrite

## Safe deployment order

1. Deploy the CDK stack in us-east-2 while the production frontend still uses
   Base44.
2. Record the CloudFormation outputs:
   - UserPoolId
   - UserPoolClientId
   - HostedAuthDomain
   - ApiUrl
   - AssetsBucketName
3. Verify the public API health endpoint returns `{"ok":true}`.
4. Migrate/copy the existing Base44 data into Aurora. Do not switch the
   frontend before character and campaign counts are reconciled.
5. In Amplify, add:
   - `VITE_BACKEND_PROVIDER=aws`
   - `VITE_AWS_REGION=us-east-2`
   - `VITE_COGNITO_USER_POOL_CLIENT_ID=<UserPoolClientId>`
   - `VITE_COGNITO_DOMAIN=<HostedAuthDomain>`
   - `VITE_AWS_API_URL=<ApiUrl>`
6. Deploy the migration branch and test with a non-production/test account:
   registration, email verification, sign-in, password reset, character
   create/edit/reopen, campaign create/join, party edits, session save, notes.
7. Enable Google OAuth only after its Google Cloud redirect URIs are configured
   and the OAuth secret exists in Secrets Manager.
8. Only after QA passes, merge/cut over the production branch and custom domain.

## Google OAuth secret

Create one AWS Secrets Manager secret containing JSON with these two fields:

```json
{
  "clientId": "GOOGLE_CLIENT_ID",
  "clientSecret": "GOOGLE_CLIENT_SECRET"
}
```

Never commit those values to GitHub. Deploy CDK with:

```bash
cd infra
npm install
npx cdk deploy -c googleOAuthSecretArn=<SECRET_ARN>
```

The app's Cognito callback URLs are already prepared for the temporary Amplify
branch URL and the gingerdragonstudios.com production origin.

## Rollback

Until the final cutover, Base44 remains the default backend. If any AWS
migration test fails, remove/omit `VITE_BACKEND_PROVIDER=aws` and redeploy the
frontend. No Base44 production data is deleted by this branch.
