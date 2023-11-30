import { RemovalPolicy } from 'aws-cdk-lib';
import {
  AttributeType,
  Table,
  TableEncryption,
  BillingMode,
} from 'aws-cdk-lib/aws-dynamodb';
import {
  AwsCustomResource,
  PhysicalResourceId,
  AwsCustomResourcePolicy,
} from 'aws-cdk-lib/custom-resources';
import { Construct } from 'constructs';

export class DatabaseResources extends Construct {
  public meetingTable: Table;
  public callCountTable: Table;

  constructor(scope: Construct, id: string) {
    super(scope, id);

    this.meetingTable = new Table(this, 'meetingTable', {
      partitionKey: {
        name: 'meetingId',
        type: AttributeType.STRING,
      },
      removalPolicy: RemovalPolicy.DESTROY,
      encryption: TableEncryption.AWS_MANAGED,
      billingMode: BillingMode.PAY_PER_REQUEST,
    });

    this.callCountTable = new Table(this, 'callCountTable', {
      partitionKey: {
        name: 'pk',
        type: AttributeType.STRING,
      },
      removalPolicy: RemovalPolicy.DESTROY,
      encryption: TableEncryption.AWS_MANAGED,
      billingMode: BillingMode.PAY_PER_REQUEST,
    });

    new AwsCustomResource(this, 'initTable', {
      installLatestAwsSdk: true,
      onCreate: {
        service: 'DynamoDB',
        action: 'batchWriteItem',
        parameters: {
          RequestItems: {
            [this.callCountTable.tableName]: [
              {
                PutRequest: {
                  Item: {
                    pk: { S: 'currentCalls' },
                    calls: { N: '0' },
                  },
                },
              },
            ],
          },
        },

        physicalResourceId: PhysicalResourceId.of(
          this.callCountTable.tableName + '_initialization',
        ),
      },
      onUpdate: {
        service: 'DynamoDB',
        action: 'batchWriteItem',
        parameters: {
          RequestItems: {
            [this.callCountTable.tableName]: [
              {
                PutRequest: {
                  Item: {
                    pk: { S: 'currentCalls' },
                    calls: { N: '0' },
                  },
                },
              },
            ],
          },
        },

        physicalResourceId: PhysicalResourceId.of(
          this.callCountTable.tableName + '_initialization',
        ),
      },
      policy: AwsCustomResourcePolicy.fromSdkCalls({
        resources: AwsCustomResourcePolicy.ANY_RESOURCE,
      }),
    });
  }
}
