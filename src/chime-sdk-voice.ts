/* eslint-disable import/no-extraneous-dependencies */
import { Duration, Stack } from 'aws-cdk-lib';
import { Table } from 'aws-cdk-lib/aws-dynamodb';
import {
  ServicePrincipal,
  Role,
  ManagedPolicy,
  PolicyDocument,
  PolicyStatement,
} from 'aws-cdk-lib/aws-iam';
import { Architecture, Runtime } from 'aws-cdk-lib/aws-lambda';
import { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs';
import { Bucket } from 'aws-cdk-lib/aws-s3';
import {
  ChimeSipMediaApp,
  ChimePhoneNumber,
  PhoneProductType,
  PhoneNumberType,
  ChimeSipRule,
  TriggerType,
} from 'cdk-amazon-chime-resources';
import { Construct } from 'constructs';

interface SIPMediaApplicationProps {
  meetingTable: Table;
  wavBucket: Bucket;
  callCountTable: Table;
}
export class SIPMediaApplication extends Construct {
  public phoneNumber: ChimePhoneNumber;
  public sipMediaApp: ChimeSipMediaApp;

  constructor(scope: Construct, id: string, props: SIPMediaApplicationProps) {
    super(scope, id);

    this.phoneNumber = new ChimePhoneNumber(this, 'phoneNumber', {
      phoneState: 'IL',
      phoneNumberType: PhoneNumberType.LOCAL,
      phoneProductType: PhoneProductType.SMA,
    });

    const smaHandlerRole = new Role(this, 'smaHandlerRole', {
      assumedBy: new ServicePrincipal('lambda.amazonaws.com'),
      inlinePolicies: {
        ['chimePolicy']: new PolicyDocument({
          statements: [
            new PolicyStatement({
              resources: ['*'],
              actions: [
                'chime:DeleteMeeting',
                'chime:CreateMeetingWithAttendees',
              ],
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

    const smaHandlerLambda = new NodejsFunction(this, 'smaHandlerLambda', {
      entry: 'src/resources/smaHandler/index.ts',
      handler: 'lambdaHandler',
      runtime: Runtime.NODEJS_18_X,
      role: smaHandlerRole,
      architecture: Architecture.ARM_64,
      timeout: Duration.seconds(60),
      environment: {
        FROM_NUMBER: this.phoneNumber.phoneNumber,
        MEETING_TABLE: props.meetingTable.tableName,
        WAV_BUCKET: props.wavBucket.bucketName,
        CALL_COUNT_TABLE: props.callCountTable.tableName,
      },
    });

    this.sipMediaApp = new ChimeSipMediaApp(this, 'sipMediaApp', {
      region: Stack.of(this).region,
      endpoint: smaHandlerLambda.functionArn,
    });

    new ChimeSipRule(this, 'sipRule', {
      triggerType: TriggerType.TO_PHONE_NUMBER,
      triggerValue: this.phoneNumber.phoneNumber,
      targetApplications: [
        { priority: 1, sipMediaApplicationId: this.sipMediaApp.sipMediaAppId },
      ],
    });

    props.meetingTable.grantReadWriteData(smaHandlerLambda);
    props.callCountTable.grantReadWriteData(smaHandlerLambda);
  }
}
