import { RemovalPolicy, Duration, Stack } from 'aws-cdk-lib';
import {
  CfnIdentityPool,
  IUserPool,
  IUserPoolClient,
  UserPool,
  UserPoolClient,
  UserPoolClientIdentityProvider,
  CfnIdentityPoolRoleAttachment,
  AccountRecovery,
  Mfa,
} from 'aws-cdk-lib/aws-cognito';
import {
  IRole,
  Role,
  PolicyStatement,
  FederatedPrincipal,
  Effect,
} from 'aws-cdk-lib/aws-iam';
import { Runtime, Architecture } from 'aws-cdk-lib/aws-lambda';
import { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs';
import { Construct } from 'constructs';

export interface CognitoStackProps {
  readonly allowedDomain: string;
}

export class Cognito extends Construct {
  public readonly authenticatedRole: IRole;
  public readonly identityPool: string;
  public readonly userPool: IUserPool;
  public readonly userPoolClient: IUserPoolClient;
  public readonly userPoolRegion: string;

  constructor(scope: Construct, id: string, props: CognitoStackProps) {
    super(scope, id);

    const domainValidator = new NodejsFunction(this, 'domainValidator', {
      entry: 'src/resources/cognitoDomain/domainValidator.ts',
      bundling: {
        externalModules: ['aws-sdk'],
      },
      runtime: Runtime.NODEJS_LATEST,
      architecture: Architecture.ARM_64,
      timeout: Duration.seconds(60),
      environment: {
        ALLOWED_DOMAIN: props.allowedDomain,
      },
    });

    const userPool = new UserPool(this, 'UserPool', {
      removalPolicy: RemovalPolicy.DESTROY,
      selfSignUpEnabled: true,
      lambdaTriggers: {
        preSignUp: domainValidator,
      },
      signInAliases: {
        username: false,
        phone: false,
        email: true,
      },
      accountRecovery: AccountRecovery.EMAIL_ONLY,
      standardAttributes: {
        email: {
          required: true,
          mutable: true,
        },
      },
      mfa: Mfa.OPTIONAL,
      mfaSecondFactor: {
        sms: true,
        otp: true,
      },
      userInvitation: {
        emailSubject:
          'Your Amazon Chime SDK Kinesis Processing web app temporary password',
        emailBody:
          'Your Amazon Chime SDK Kinesis Processing web app username is {username} and temporary password is {####}\n',
      },
      userVerification: {
        emailSubject:
          'Verify your new Amazon Chime SDK Kinesis Processing web app account',
        emailBody:
          'The verification code to your new Amazon Chime SDK Kinesis Processing web app account is {####}\n',
      },
    });

    const userPoolClient = new UserPoolClient(this, 'UserPoolClient', {
      userPool: userPool,
      generateSecret: false,
      supportedIdentityProviders: [UserPoolClientIdentityProvider.COGNITO],
      authFlows: {
        userSrp: true,
        custom: true,
      },
      refreshTokenValidity: Duration.hours(1),
    });

    const identityPool = new CfnIdentityPool(this, 'cognitoIdentityPool', {
      identityPoolName: 'cognitoIdentityPool',
      allowUnauthenticatedIdentities: false,
      cognitoIdentityProviders: [
        {
          clientId: userPoolClient.userPoolClientId,
          providerName: userPool.userPoolProviderName,
        },
      ],
    });

    const unauthenticatedRole = new Role(
      this,
      'CognitoDefaultUnauthenticatedRole',
      {
        assumedBy: new FederatedPrincipal(
          'cognito-identity.amazonaws.com',
          {
            // eslint-disable-next-line quote-props
            'StringEquals': {
              'cognito-identity.amazonaws.com:aud': identityPool.ref,
            },
            'ForAnyValue:StringLike': {
              'cognito-identity.amazonaws.com:amr': 'unauthenticated',
            },
          },
          'sts:AssumeRoleWithWebIdentity',
        ),
      },
    );

    unauthenticatedRole.addToPolicy(
      new PolicyStatement({
        effect: Effect.ALLOW,
        actions: ['mobileanalytics:PutEvents', 'cognito-sync:*'],
        resources: ['*'],
      }),
    );

    const authenticatedRole = new Role(
      this,
      'CognitoDefaultAuthenticatedRole',
      {
        assumedBy: new FederatedPrincipal(
          'cognito-identity.amazonaws.com',
          {
            // eslint-disable-next-line quote-props
            'StringEquals': {
              'cognito-identity.amazonaws.com:aud': identityPool.ref,
            },
            'ForAnyValue:StringLike': {
              'cognito-identity.amazonaws.com:amr': 'authenticated',
            },
          },
          'sts:AssumeRoleWithWebIdentity',
        ),
      },
    );

    authenticatedRole.addToPolicy(
      new PolicyStatement({
        effect: Effect.ALLOW,
        actions: [
          'mobileanalytics:PutEvents',
          'cognito-sync:*',
          'cognito-identity:*',
        ],
        resources: ['*'],
      }),
    );

    new CfnIdentityPoolRoleAttachment(this, 'DefaultValid', {
      identityPoolId: identityPool.ref,
      roles: {
        unauthenticated: unauthenticatedRole.roleArn,
        authenticated: authenticatedRole.roleArn,
      },
    });

    this.authenticatedRole = authenticatedRole;
    this.identityPool = identityPool.ref;
    this.userPool = userPool;
    this.userPoolClient = userPoolClient;
    this.userPoolRegion = Stack.of(this).region;
  }
}
