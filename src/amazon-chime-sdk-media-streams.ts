/* eslint-disable import/no-extraneous-dependencies */
import { App, CfnOutput, Stack, StackProps } from 'aws-cdk-lib';
import { Construct } from 'constructs';
import { config } from 'dotenv';
import {
  KinesisVideoStreamPoolResources,
  CreateCallResources,
  EventBridgeResources,
  Cognito,
  SIPMediaApplication,
  DatabaseResources,
  S3Resources,
  ECSResources,
  VPCResources,
  CloudWatchResources,
} from './index';

config();

export interface AmazonChimeSDKMediaStreamsProps extends StackProps {
  logLevel: string;
}

export class AmazonChimeSDKMediaStreams extends Stack {
  constructor(
    scope: Construct,
    id: string,
    props: AmazonChimeSDKMediaStreamsProps,
  ) {
    super(scope, id, props);

    const kinesisVideoPoolStreamResources = new KinesisVideoStreamPoolResources(
      this,
      'KinesisVideoStreamPoolResources',
    );

    const cognitoResources = new Cognito(this, 'Cognito', {
      allowedDomain: '',
    });
    const cloudWatchResources = new CloudWatchResources(
      this,
      'cloudWatchResources',
    );

    const databaseResources = new DatabaseResources(this, 'databaseResources');
    const s3Resources = new S3Resources(this, 's3Resources');

    const vpcResources = new VPCResources(this, 'vpcResources');

    const sipMediaApplication = new SIPMediaApplication(
      this,
      'sipMediaApplication',
      {
        meetingTable: databaseResources.meetingTable,
        wavBucket: s3Resources.outgoingWav,
        callCountTable: databaseResources.callCountTable,
      },
    );

    const kvsConsumer = new ECSResources(this, 'kvsConsumer', {
      sipMediaApplication: sipMediaApplication.sipMediaApp,
      meetingTable: databaseResources.meetingTable,
      vpc: vpcResources.vpc,
      albSecurityGroup: vpcResources.albSecurityGroup,
      callsPerTaskMetric: cloudWatchResources.callsPerTaskMetric,
    });

    new EventBridgeResources(this, 'eventBridgeResources', {
      kinesisVideoStreamPool:
        kinesisVideoPoolStreamResources.kinesisVideoStreamPool,
      kvsConsumer: kvsConsumer.fargateService,
      meetingTable: databaseResources.meetingTable,
      vpc: vpcResources.vpc,
      albSecurityGroup: vpcResources.albSecurityGroup,
      callCountTable: databaseResources.callCountTable,
      fargateCluster: kvsConsumer.fargateService.cluster,
    });

    new CreateCallResources(this, 'createCallResources', {
      fromPhoneNumber: sipMediaApplication.phoneNumber,
      smaId: sipMediaApplication.sipMediaApp,
      userPool: cognitoResources.userPool,
      meetingTable: databaseResources.meetingTable,
    });

    new CfnOutput(this, 'PhoneNumber', {
      value: sipMediaApplication.phoneNumber.phoneNumber,
    });

    new CfnOutput(this, 'LogGroup', {
      value: kvsConsumer.logGroup.logGroupName,
    });
  }
}

const props = {
  logLevel: process.env.LOG_LEVEL || '',
};
const devEnv = {
  account: process.env.CDK_DEFAULT_ACCOUNT,
  region: process.env.CDK_DEFAULT_REGION,
};

const app = new App();

new AmazonChimeSDKMediaStreams(app, 'AmazonChimeSDKMediaStreams', {
  ...props,
  env: devEnv,
});

app.synth();
