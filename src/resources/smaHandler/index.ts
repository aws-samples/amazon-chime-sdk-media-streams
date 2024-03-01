/* eslint-disable import/no-extraneous-dependencies */
/*eslint import/no-unresolved: 0 */
import { randomUUID } from 'crypto';
import {
  ChimeSDKMeetingsClient,
  DeleteMeetingCommand,
  CreateMeetingWithAttendeesCommand,
  CreateMeetingWithAttendeesCommandOutput,
} from '@aws-sdk/client-chime-sdk-meetings';

import {
  DynamoDBClient,
  PutItemCommand,
  UpdateItemCommand,
} from '@aws-sdk/client-dynamodb';

import {
  ActionTypes,
  InvocationEventType,
  SchemaVersion,
  SipMediaApplicationEvent,
  SipMediaApplicationResponse,
  Actions,
  PollyLanguageCodes,
  Engine,
  TextType,
  PollyVoiceIds,
  PlayAudioActionParameters,
} from './sip-media-application';

const MEETING_TABLE = process.env.MEETING_TABLE;
const CALL_COUNT_TABLE = process.env.CALL_COUNT_TABLE;
const WAV_BUCKET = process.env.WAV_BUCKET || '';

const ddbClient = new DynamoDBClient({ region: 'us-east-1' });
const chimeSDKMeetingClient = new ChimeSDKMeetingsClient({
  region: 'us-east-1',
});

export const lambdaHandler = async (
  event: SipMediaApplicationEvent,
): Promise<SipMediaApplicationResponse> => {
  console.log('Lambda is invoked with call details:' + JSON.stringify(event));
  let actions: Actions[] = [];
  let transactionAttributes;
  let meetingInfo: CreateMeetingWithAttendeesCommandOutput | undefined;
  if (event.CallDetails.TransactionAttributes) {
    transactionAttributes = event.CallDetails.TransactionAttributes;
  } else {
    transactionAttributes = {
      MeetingId: '',
      CallIdLegA: '',
      CallIdLegB: '',
    };
  }

  switch (event.InvocationEventType) {
    case InvocationEventType.NEW_OUTBOUND_CALL:
      console.log('OUTBOUND CALL');
      actions = [];
      break;
    case InvocationEventType.RINGING:
      console.log('RINGING');
      actions = [];
      break;
    case InvocationEventType.NEW_INBOUND_CALL:
      console.log('NEW_INBOUND_CALL');
      meetingInfo = await createMeeting();
      await writeMeetingInfoToDB(
        meetingInfo.Meeting!.MeetingId!,
        event.CallDetails.TransactionId,
      );
      await updateCallCount(1);
      transactionAttributes.MeetingId = meetingInfo.Meeting!.MeetingId!;
      actions = [
        joinChimeMeetingAction(
          meetingInfo,
          event.CallDetails.Participants[0].CallId,
        ),
      ];
      break;

    case InvocationEventType.ACTION_SUCCESSFUL:
      console.log('ACTION SUCCESSFUL');
      const legAParticipant = event.CallDetails.Participants.find(
        (participant) => participant.ParticipantTag === 'LEG-A',
      );
      const legBParticipant = event.CallDetails.Participants.find(
        (participant) => participant.ParticipantTag === 'LEG-B',
      );

      transactionAttributes.CallIdLegA = legAParticipant
        ? legAParticipant.CallId
        : '';
      transactionAttributes.CallIdLegB = legBParticipant
        ? legBParticipant.CallId
        : '';

      switch (event.ActionData!.Type) {
        case ActionTypes.JOIN_CHIME_MEETING:
          console.log('JOIN_CHIME_MEETING');
          actions = [
            speakAction(
              'Please wait while we connect you with a bot.  You can ask a question and the bot will query Bedrock.',
              transactionAttributes.CallIdLegA,
            ),
          ];
          break;
        default:
          break;
      }
      break;

    case InvocationEventType.CALL_UPDATE_REQUESTED:
      console.log('CALL_UPDATE_REQUESTED');
      switch (event.ActionData?.Parameters.Arguments.Function) {
        case 'Response':
          actions = [
            speakAction(
              event.ActionData!.Parameters.Arguments.Text,
              transactionAttributes.CallIdLegA,
            ),
          ];
          break;
        case 'Thinking':
          actions = [playAudioAction(transactionAttributes.CallIdLegA)];
          break;
        default:
          break;
      }
      break;

    case InvocationEventType.HANGUP:
      console.log('HANGUP ACTION');

      if (event.ActionData?.Parameters.ParticipantTag === 'LEG-A') {
        console.log('Hangup from Leg A - Hangup Leg B');

        actions = [hangupAction(transactionAttributes.CallIdLegB)];
      } else {
        actions = [];
      }
      await chimeSDKMeetingClient.send(
        new DeleteMeetingCommand({
          MeetingId: transactionAttributes.MeetingId,
        }),
      );
      await updateCallCount(-1);
      break;
    case InvocationEventType.CALL_ANSWERED:
      console.log('CALL ANSWERED');
      meetingInfo = await createMeeting();
      await writeMeetingInfoToDB(
        meetingInfo.Meeting!.MeetingId!,
        event.CallDetails.TransactionId,
      );
      transactionAttributes.MeetingId = meetingInfo.Meeting!.MeetingId!;
      actions = [
        joinChimeMeetingAction(
          meetingInfo,
          event.CallDetails.Participants[0].CallId,
        ),
      ];
      break;
    default:
      console.log('FAILED ACTION');
      actions = [];
  }

  const response: SipMediaApplicationResponse = {
    SchemaVersion: SchemaVersion.VERSION_1_0,
    Actions: actions,
    TransactionAttributes: transactionAttributes,
  };

  console.log('Sending response:' + JSON.stringify(response));
  return response;
};

function hangupAction(callId: string) {
  return {
    Type: ActionTypes.HANGUP,
    Parameters: {
      SipResponseCode: '0',
      CallId: callId,
    },
  };
}

function speakAction(text: string, callId: string) {
  return {
    Type: ActionTypes.SPEAK,
    Parameters: {
      Text: text,
      CallId: callId,
      Engine: Engine.NEURAL,
      LanguageCode: PollyLanguageCodes.EN_US,
      TextType: TextType.TEXT,
      VoiceId: PollyVoiceIds.JOANNA,
    },
  };
}

function joinChimeMeetingAction(
  meetingInfo: CreateMeetingWithAttendeesCommandOutput,
  callId: string,
) {
  return {
    Type: ActionTypes.JOIN_CHIME_MEETING,
    Parameters: {
      JoinToken: meetingInfo.Attendees![0].JoinToken!,
      CallId: callId,
      MeetingId: meetingInfo.Meeting!.MeetingId!,
    },
  };
}

function playAudioAction(callId: string) {
  return {
    Type: ActionTypes.PLAY_AUDIO,
    CallId: callId,
    Parameters: {
      Repeat: 2,
      AudioSource: {
        Type: 'S3',
        BucketName: WAV_BUCKET,
        Key: 'timer.wav',
      },
    } as PlayAudioActionParameters,
  };
}

async function createMeeting() {
  console.log('Creating Meeting for Request ID');
  try {
    const meetingInfo = await chimeSDKMeetingClient.send(
      new CreateMeetingWithAttendeesCommand({
        ClientRequestToken: randomUUID(),
        MediaRegion: 'us-east-1',
        ExternalMeetingId: 'MediaStreams',
        Attendees: [{ ExternalUserId: randomUUID() }],
      }),
    );
    return meetingInfo;
  } catch (error) {
    console.info(`Error: ${error}`);
    throw error;
  }
}

async function writeMeetingInfoToDB(meetingId: string, transactionId: string) {
  const params = {
    TableName: MEETING_TABLE,
    Item: {
      meetingId: { S: meetingId },
      transactionId: { S: transactionId },
    },
  };

  try {
    await ddbClient.send(new PutItemCommand(params));
    console.log(`Meeting info written to DB for meetingId: ${meetingId}`);
  } catch (error) {
    console.error(`Error writing to DB: ${error}`);
    throw error;
  }
}

async function updateCallCount(value: number) {
  console.log(`Updating call count with : ${value}`);
  try {
    const updateParams = {
      TableName: CALL_COUNT_TABLE,
      Key: { pk: { S: 'currentCalls' } },
      UpdateExpression: 'ADD #calls :val',
      ExpressionAttributeNames: {
        '#calls': 'calls',
      },
      ExpressionAttributeValues: {
        ':val': { N: value.toString() },
      },
    };

    const response = await ddbClient.send(new UpdateItemCommand(updateParams));
    console.log(response);
  } catch (error) {
    console.error('Error:', error);
  }
}
