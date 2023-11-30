import { Stack, Duration } from 'aws-cdk-lib';
import {
  RestApi,
  LambdaIntegration,
  EndpointType,
  MethodLoggingLevel,
  CognitoUserPoolsAuthorizer,
  AuthorizationType,
} from 'aws-cdk-lib/aws-apigateway';
import { IUserPool } from 'aws-cdk-lib/aws-cognito';
import { Table } from 'aws-cdk-lib/aws-dynamodb';
import {
  Port,
  SecurityGroup,
  SubnetType,
  Vpc,
  Connections,
} from 'aws-cdk-lib/aws-ec2';
import { ICluster } from 'aws-cdk-lib/aws-ecs';
import { ApplicationLoadBalancedFargateService } from 'aws-cdk-lib/aws-ecs-patterns';
import { Rule, Schedule } from 'aws-cdk-lib/aws-events';
import { LambdaFunction } from 'aws-cdk-lib/aws-events-targets';
import {
  ManagedPolicy,
  Role,
  PolicyStatement,
  PolicyDocument,
  ServicePrincipal,
} from 'aws-cdk-lib/aws-iam';
import { Architecture, Runtime } from 'aws-cdk-lib/aws-lambda';
import { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs';
import {
  ChimePhoneNumber,
  ChimeSipMediaApp,
  KinesisVideoStreamPool,
} from 'cdk-amazon-chime-resources';
import { Construct } from 'constructs';

interface CreateCallResourcesProps {
  fromPhoneNumber: ChimePhoneNumber;
  smaId: ChimeSipMediaApp;
  userPool: IUserPool;
  meetingTable: Table;
}

export class CreateCallResources extends Construct {
  public apiUrl: string;

  constructor(scope: Construct, id: string, props: CreateCallResourcesProps) {
    super(scope, id);

    const createCallRole = new Role(this, 'createCallRole', {
      assumedBy: new ServicePrincipal('lambda.amazonaws.com'),
      inlinePolicies: {
        ['chimePolicy']: new PolicyDocument({
          statements: [
            new PolicyStatement({
              resources: ['*'],
              actions: ['chime:CreateSipMediaApplicationCall'],
            }),
          ],
        }),
      },
      managedPolicies: [
        ManagedPolicy.fromAwsManagedPolicyName(
          'service-role/AWSLambdaBasicExecutionRole',
        ),
      ],
    });

    const createCallLambda = new NodejsFunction(this, 'createCalls', {
      entry: 'src/resources/createCalls/index.ts',
      runtime: Runtime.NODEJS_18_X,
      architecture: Architecture.ARM_64,
      role: createCallRole,
      timeout: Duration.seconds(60),
      environment: {
        SIP_MEDIA_APPLICATION_ID: props.smaId.sipMediaAppId,
        FROM_NUMBER: props.fromPhoneNumber.phoneNumber,
      },
    });

    const api = new RestApi(this, 'AmazonChimeSDKKinesisProcessingAPI', {
      defaultCorsPreflightOptions: {
        allowHeaders: [
          'Content-Type',
          'X-Amz-Date',
          'Authorization',
          'X-Api-Key',
        ],
        allowMethods: ['OPTIONS', 'POST'],
        allowCredentials: true,
        allowOrigins: ['*'],
      },
      deployOptions: {
        loggingLevel: MethodLoggingLevel.INFO,
        dataTraceEnabled: true,
      },
      endpointConfiguration: {
        types: [EndpointType.REGIONAL],
      },
    });

    const auth = new CognitoUserPoolsAuthorizer(this, 'auth', {
      cognitoUserPools: [props.userPool],
    });

    const dial = api.root.addResource('create');

    const createCallIntegration = new LambdaIntegration(createCallLambda);

    dial.addMethod('POST', createCallIntegration, {
      authorizer: auth,
      authorizationType: AuthorizationType.COGNITO,
    });

    this.apiUrl = api.url;
  }
}

interface EventBridgeResourcesProps {
  kinesisVideoStreamPool: KinesisVideoStreamPool;
  kvsConsumer: ApplicationLoadBalancedFargateService;
  meetingTable: Table;
  vpc: Vpc;
  albSecurityGroup: SecurityGroup;
  callCountTable: Table;
  fargateCluster: ICluster;
}

export class EventBridgeResources extends Construct {
  constructor(scope: Construct, id: string, props: EventBridgeResourcesProps) {
    super(scope, id);

    const eventBridgeRole = new Role(this, 'eventBridgeRole', {
      assumedBy: new ServicePrincipal('lambda.amazonaws.com'),
      inlinePolicies: {
        ['chimePolicy']: new PolicyDocument({
          statements: [
            new PolicyStatement({
              resources: ['*'],
              actions: ['chime:CreateMediaStreamPipeline'],
            }),
          ],
        }),
      },
      managedPolicies: [
        ManagedPolicy.fromAwsManagedPolicyName(
          'service-role/AWSLambdaBasicExecutionRole',
        ),
        ManagedPolicy.fromAwsManagedPolicyName(
          'service-role/AWSLambdaVPCAccessExecutionRole',
        ),
      ],
    });

    const lambdaSecurityGroup = new SecurityGroup(this, 'LambdaSecurityGroup', {
      vpc: props.vpc,
    });

    lambdaSecurityGroup.addEgressRule(props.albSecurityGroup, Port.tcp(80));

    props.albSecurityGroup.connections.allowFrom(
      new Connections({
        securityGroups: [lambdaSecurityGroup],
      }),
      Port.tcp(80),
      'allow traffic on port 80 from the Lambda security group',
    );
    const eventBridgeLambda = new NodejsFunction(this, 'eventBridge', {
      entry: 'src/resources/eventBridge/index.ts',
      runtime: Runtime.NODEJS_LATEST,
      architecture: Architecture.ARM_64,
      role: eventBridgeRole,
      timeout: Duration.seconds(60),
      vpc: props.vpc,
      vpcSubnets: { subnetType: SubnetType.PRIVATE_WITH_EGRESS },
      securityGroups: [lambdaSecurityGroup],
      environment: {
        KINESIS_VIDEO_STREAM_POOL_ARN: props.kinesisVideoStreamPool.poolArn,
        AWS_ACCOUNT: Stack.of(this).account,
        KVS_CONSUMER_URL: props.kvsConsumer.loadBalancer.loadBalancerDnsName,
        MEETING_TABLE: props.meetingTable.tableName,
      },
    });
    const chimeSDKRule = new Rule(this, 'chimeSDKRule', {
      eventPattern: {
        source: ['aws.chime'],
        detailType: [
          'Chime Meeting State Change',
          'Chime Media Pipeline State Change',
          'Chime Media Pipeline Kinesis Video Pool State Change',
        ],
      },
    });
    chimeSDKRule.addTarget(new LambdaFunction(eventBridgeLambda));

    const callCountScheduleRole = new Role(this, 'callCountScheduleRole', {
      assumedBy: new ServicePrincipal('lambda.amazonaws.com'),
      inlinePolicies: {
        ['cloudwatchPolicy']: new PolicyDocument({
          statements: [
            new PolicyStatement({
              resources: ['*'],
              actions: ['cloudwatch:PutMetricData'],
            }),
          ],
        }),
        ['ecsPolicy']: new PolicyDocument({
          statements: [
            new PolicyStatement({
              resources: ['*'],
              actions: ['ecs:DescribeClusters'],
            }),
          ],
        }),
      },
      managedPolicies: [
        ManagedPolicy.fromAwsManagedPolicyName(
          'service-role/AWSLambdaBasicExecutionRole',
        ),
      ],
    });

    const callCountMetricLambda = new NodejsFunction(
      this,
      'callCountScheduleLambda',
      {
        entry: 'src/resources/callCountMetric/index.ts',
        runtime: Runtime.NODEJS_LATEST,
        architecture: Architecture.ARM_64,
        role: callCountScheduleRole,
        timeout: Duration.seconds(60),
        environment: {
          CALL_COUNT_TABLE: props.callCountTable.tableName,
          FARGATE_CLUSTER: props.fargateCluster.clusterName,
        },
      },
    );

    props.callCountTable.grantReadWriteData(callCountMetricLambda);

    new Rule(this, 'CallCountRule', {
      schedule: Schedule.rate(Duration.minutes(1)),
      targets: [new LambdaFunction(callCountMetricLambda)],
    });
  }
}
