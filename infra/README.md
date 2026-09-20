# AWS infrastructure

This folder is an isolated AWS CDK v2 project. It does not affect the current Base44 production app.

## Resources currently defined

- Cognito User Pool + web client
- isolated VPC/database subnets
- Aurora PostgreSQL Serverless v2 cluster with Data API enabled
- private/versioned S3 bucket
- generated DB secret in AWS Secrets Manager
- deletion protection and retention/snapshot safeguards

The next infrastructure step is the authenticated API layer. Do not expose Aurora directly to the browser.

## Local commands

```bash
cd infra
npm install
npx cdk synth
```

Deployment requires an authenticated AWS account and an explicit review of the generated CloudFormation template.
