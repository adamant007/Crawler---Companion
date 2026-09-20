import * as path from "node:path";
import * as cdk from "aws-cdk-lib";
import * as apigwv2 from "aws-cdk-lib/aws-apigatewayv2";
import * as authorizers from "aws-cdk-lib/aws-apigatewayv2-authorizers";
import * as integrations from "aws-cdk-lib/aws-apigatewayv2-integrations";
import * as cognito from "aws-cdk-lib/aws-cognito";
import * as cr from "aws-cdk-lib/custom-resources";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as logs from "aws-cdk-lib/aws-logs";
import * as rds from "aws-cdk-lib/aws-rds";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as secretsmanager from "aws-cdk-lib/aws-secretsmanager";
import { Construct } from "constructs";

export class GingerDragonStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    /*
     * Keep the temporary Amplify branch URL and the future production domain
     * explicit. This prevents a wildcard CORS/auth redirect policy from
     * accidentally becoming permanent.
     */
    const allowedOrigins = [
      "https://aws-migration.dnmkfhi0tz2lb.amplifyapp.com",
      "https://gingerdragonstudios.com",
      "http://localhost:5173",
    ];

    const vpc = new ec2.Vpc(this, "Vpc", {
      maxAzs: 2,
      natGateways: 0,
      subnetConfiguration: [
        {
          name: "public",
          subnetType: ec2.SubnetType.PUBLIC,
          cidrMask: 24,
        },
        {
          name: "database",
          subnetType: ec2.SubnetType.PRIVATE_ISOLATED,
          cidrMask: 24,
        },
      ],
    });

    const userPool = new cognito.UserPool(this, "Users", {
      userPoolName: "ginger-dragon-users",
      selfSignUpEnabled: true,
      signInAliases: { email: true },
      signInCaseSensitive: false,
      autoVerify: { email: true },
      accountRecovery: cognito.AccountRecovery.EMAIL_ONLY,
      featurePlan: cognito.FeaturePlan.LITE,
      passwordPolicy: {
        minLength: 10,
        requireDigits: true,
        requireLowercase: true,
        requireUppercase: true,
        requireSymbols: false,
      },
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    /*
     * Google sign-in is optional at synth time so CI and first deployment do
     * not require a secret in source control. To enable it, store
     * {"clientId":"...","clientSecret":"..."} in Secrets Manager and deploy
     * with -c googleOAuthSecretArn=<secret ARN>.
     */
    const supportedIdentityProviders = [
      cognito.UserPoolClientIdentityProvider.COGNITO,
    ];
    const googleOAuthSecretArn = this.node.tryGetContext("googleOAuthSecretArn") as
      | string
      | undefined;
    let googleProvider: cognito.UserPoolIdentityProviderGoogle | undefined;

    if (googleOAuthSecretArn) {
      const googleSecret = secretsmanager.Secret.fromSecretCompleteArn(
        this,
        "GoogleOAuthSecret",
        googleOAuthSecretArn,
      );
      googleProvider = new cognito.UserPoolIdentityProviderGoogle(
        this,
        "GoogleIdentityProvider",
        {
          userPool,
          clientId: googleSecret.secretValueFromJson("clientId").unsafeUnwrap(),
          clientSecretValue: googleSecret.secretValueFromJson("clientSecret"),
          scopes: ["openid", "email", "profile"],
          attributeMapping: {
            email: cognito.ProviderAttribute.GOOGLE_EMAIL,
            givenName: cognito.ProviderAttribute.GOOGLE_GIVEN_NAME,
            familyName: cognito.ProviderAttribute.GOOGLE_FAMILY_NAME,
          },
        },
      );
      supportedIdentityProviders.push(
        cognito.UserPoolClientIdentityProvider.GOOGLE,
      );
    }

    const userPoolClient = userPool.addClient("WebClient", {
      userPoolClientName: "ginger-dragon-web",
      authFlows: {
        userPassword: true,
        userSrp: true,
      },
      preventUserExistenceErrors: true,
      generateSecret: false,
      accessTokenValidity: cdk.Duration.hours(1),
      idTokenValidity: cdk.Duration.hours(1),
      refreshTokenValidity: cdk.Duration.days(30),
      supportedIdentityProviders,
      oAuth: {
        flows: {
          authorizationCodeGrant: true,
        },
        scopes: [
          cognito.OAuthScope.OPENID,
          cognito.OAuthScope.EMAIL,
          cognito.OAuthScope.PROFILE,
        ],
        callbackUrls: allowedOrigins.map((origin) => `${origin}/auth/callback`),
        logoutUrls: allowedOrigins.map((origin) => `${origin}/login`),
      },
    });
    if (googleProvider) userPoolClient.node.addDependency(googleProvider);

    const userPoolDomain = userPool.addDomain("HostedAuthDomain", {
      cognitoDomain: {
        // Account id makes the prefix effectively unique without a manual name.
        domainPrefix: `ginger-dragon-${this.account}`,
      },
    });

    const assets = new s3.Bucket(this, "PrivateAssets", {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      versioned: true,
      lifecycleRules: [
        {
          noncurrentVersionExpiration: cdk.Duration.days(30),
          abortIncompleteMultipartUploadAfter: cdk.Duration.days(7),
        },
      ],
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      autoDeleteObjects: false,
    });

    const dbSecurityGroup = new ec2.SecurityGroup(this, "DatabaseSecurityGroup", {
      vpc,
      allowAllOutbound: false,
      description: "Aurora PostgreSQL access boundary",
    });

    const database = new rds.DatabaseCluster(this, "Database", {
      engine: rds.DatabaseClusterEngine.auroraPostgres({
        version: rds.AuroraPostgresEngineVersion.VER_17_5,
      }),
      writer: rds.ClusterInstance.serverlessV2("writer"),
      /*
       * Cost guardrail for migration / early production. Aurora can pause when
       * idle and may not exceed 1 ACU unless this limit is deliberately changed.
       */
      serverlessV2MinCapacity: 0,
      serverlessV2MaxCapacity: 1,
      serverlessV2AutoPauseDuration: cdk.Duration.minutes(5),
      enableDataApi: true,
      credentials: rds.Credentials.fromGeneratedSecret("gingerdragon_app"),
      defaultDatabaseName: "gingerdragon",
      storageEncrypted: true,
      vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_ISOLATED },
      securityGroups: [dbSecurityGroup],
      backup: { retention: cdk.Duration.days(14) },
      deletionProtection: true,
      removalPolicy: cdk.RemovalPolicy.SNAPSHOT,
    });

    const migrationFunction = new lambda.Function(this, "MigrationFunction", {
      functionName: "ginger-dragon-db-migration",
      runtime: lambda.Runtime.NODEJS_22_X,
      handler: "migrate.handler",
      code: lambda.Code.fromAsset(path.join(__dirname, "../migration")),
      memorySize: 256,
      timeout: cdk.Duration.minutes(5),
      logRetention: logs.RetentionDays.ONE_MONTH,
      environment: {
        DB_CLUSTER_ARN: database.clusterArn,
        DB_SECRET_ARN: database.secret!.secretArn,
        DB_NAME: "gingerdragon",
      },
    });

    database.grantDataApiAccess(migrationFunction);
    database.secret!.grantRead(migrationFunction);

    const migrationProvider = new cr.Provider(this, "MigrationProvider", {
      onEventHandler: migrationFunction,
      logRetention: logs.RetentionDays.ONE_MONTH,
    });

    new cdk.CustomResource(this, "DatabaseSchema", {
      serviceToken: migrationProvider.serviceToken,
      properties: {
        schemaVersion: "003",
      },
    });

    const apiFunction = new lambda.Function(this, "ApiFunction", {
      functionName: "ginger-dragon-api",
      runtime: lambda.Runtime.NODEJS_22_X,
      handler: "api.handler",
      code: lambda.Code.fromAsset(path.join(__dirname, "../lambda")),
      memorySize: 512,
      timeout: cdk.Duration.seconds(20),
      // Early-stage cost/safety guardrail. Raise deliberately when real
      // concurrent usage proves it is needed.
      reservedConcurrentExecutions: 20,
      logRetention: logs.RetentionDays.ONE_MONTH,
      environment: {
        DB_CLUSTER_ARN: database.clusterArn,
        DB_SECRET_ARN: database.secret!.secretArn,
        DB_NAME: "gingerdragon",
        ASSETS_BUCKET: assets.bucketName,
      },
    });

    database.grantDataApiAccess(apiFunction);
    database.secret!.grantRead(apiFunction);
    assets.grantReadWrite(apiFunction);

    const apiIntegration = new integrations.HttpLambdaIntegration(
      "ApiIntegration",
      apiFunction,
    );

    const api = new apigwv2.HttpApi(this, "Api", {
      apiName: "ginger-dragon-api",
      corsPreflight: {
        allowOrigins: allowedOrigins,
        allowHeaders: ["authorization", "content-type"],
        allowMethods: [
          apigwv2.CorsHttpMethod.GET,
          apigwv2.CorsHttpMethod.POST,
          apigwv2.CorsHttpMethod.PATCH,
          apigwv2.CorsHttpMethod.DELETE,
          apigwv2.CorsHttpMethod.OPTIONS,
        ],
        maxAge: cdk.Duration.days(1),
      },
    });

    const apiAuthorizer = new authorizers.HttpUserPoolAuthorizer(
      "UserPoolAuthorizer",
      userPool,
      { userPoolClients: [userPoolClient] },
    );

    // Health is deliberately public so deployments can be checked without auth.
    api.addRoutes({
      path: "/health",
      methods: [apigwv2.HttpMethod.GET],
      integration: apiIntegration,
    });

    const protectedRoutes: Array<{
      path: string;
      methods: apigwv2.HttpMethod[];
    }> = [
      { path: "/me", methods: [apigwv2.HttpMethod.GET, apigwv2.HttpMethod.PATCH] },
      { path: "/characters", methods: [apigwv2.HttpMethod.GET, apigwv2.HttpMethod.POST] },
      {
        path: "/characters/{id}",
        methods: [
          apigwv2.HttpMethod.GET,
          apigwv2.HttpMethod.PATCH,
          apigwv2.HttpMethod.DELETE,
        ],
      },
      { path: "/campaigns", methods: [apigwv2.HttpMethod.GET, apigwv2.HttpMethod.POST] },
      { path: "/gm-notes", methods: [apigwv2.HttpMethod.GET, apigwv2.HttpMethod.POST] },
      {
        path: "/gm-notes/{id}",
        methods: [apigwv2.HttpMethod.PATCH, apigwv2.HttpMethod.DELETE],
      },
      { path: "/sessions", methods: [apigwv2.HttpMethod.GET] },
      { path: "/actions/{name}", methods: [apigwv2.HttpMethod.POST] },
      {
        path: "/campaigns/{id}",
        methods: [
          apigwv2.HttpMethod.GET,
          apigwv2.HttpMethod.PATCH,
          apigwv2.HttpMethod.DELETE,
        ],
      },
    ];

    for (const route of protectedRoutes) {
      api.addRoutes({
        path: route.path,
        methods: route.methods,
        integration: apiIntegration,
        authorizer: apiAuthorizer,
      });
    }

    new cdk.CfnOutput(this, "UserPoolId", { value: userPool.userPoolId });
    new cdk.CfnOutput(this, "UserPoolClientId", { value: userPoolClient.userPoolClientId });
    new cdk.CfnOutput(this, "HostedAuthDomain", {
      value: userPoolDomain.baseUrl(),
    });
    new cdk.CfnOutput(this, "ApiUrl", { value: api.apiEndpoint });
    new cdk.CfnOutput(this, "AssetsBucketName", { value: assets.bucketName });
    new cdk.CfnOutput(this, "DatabaseClusterArn", { value: database.clusterArn });
    new cdk.CfnOutput(this, "DatabaseSecretArn", { value: database.secret!.secretArn });
  }
}
