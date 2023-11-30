/* eslint-disable import/no-extraneous-dependencies */
import {
  ChimeSDKMediaPipelinesClient,
  CreateMediaStreamPipelineCommand,
  MediaPipelineSourceType,
  MediaStreamPipelineSinkType,
  MediaStreamType,
} from '@aws-sdk/client-chime-sdk-media-pipelines';

import { Handler } from 'aws-cdk-lib/aws-lambda';
import axios from 'axios';
import {
  MeetingEventType,
  MediaStreamPipelineEventType,
  MeetingEventDetails,
  EventBridge,
  DetailType,
} from './types';

const chimeSdkMediaPipelinesClient = new ChimeSDKMediaPipelinesClient({
  region: 'us-east-1',
});

interface ConsumerInfo {
  startFragmentNumber: string;
  meetingId: string;
  attendeeId: string;
  callStreamingStartTime: string;
  callerStreamArn: string;
}

var KINESIS_VIDEO_STREAM_POOL_ARN = process.env.KINESIS_VIDEO_STREAM_POOL_ARN;
var KVS_CONSUMER_URL = process.env.KVS_CONSUMER_URL || '';
var AWS_REGION = process.env.AWS_REGION;
var AWS_ACCOUNT = process.env.AWS_ACCOUNT;

export const handler: Handler = async (event: EventBridge): Promise<null> => {
  console.info(JSON.stringify(event, null, 2));

  switch (event['detail-type']) {
    case DetailType.CHIME_MEETING_STATE_CHANGE:
      switch (event.detail.eventType) {
        case MeetingEventType.MeetingStarted:
          console.log('Meeting Started');
          await startMediaStreamPipeline(event.detail);
          break;
        case MeetingEventType.AttendeeDropped:
        case MeetingEventType.AttendeeLeft:
          console.log('Attendee Left');
          break;
      }
      break;
    case DetailType.CHIME_MEDIA_PIPELINE_STATE_CHANGE:
      switch (event.detail.eventType) {
        case MediaStreamPipelineEventType.MediaPipelineKinesisVideoStreamStart:
          console.log('MediaPipelineKinesisVideoStreamStart');
          const consumerInfo = {
            startFragmentNumber: event.detail.startFragmentNumber,
            meetingId: event.detail.meetingId,
            attendeeId: event.detail.attendeeId,
            callStreamingStartTime: event.detail.startTime,
            callerStreamArn: event.detail.kinesisVideoStreamArn,
          };
          await startConsumer(consumerInfo);
          break;
        case MediaStreamPipelineEventType.MediaPipelineKinesisVideoStreamEnd:
          console.log('MediaPipelineKinesisVideoStreamEnd');
          break;
      }
      break;
    case DetailType.CHIME_MEDIA_PIPELINE_KINESIS_VIDEO_POOL_STATE_CHANGE:
      break;
  }
  return null;
};

async function startMediaStreamPipeline(eventDetail: MeetingEventDetails) {
  try {
    const params = {
      Sinks: [
        {
          MediaStreamType: MediaStreamType.IndividualAudio,
          ReservedStreamCapacity: 1,
          SinkArn: KINESIS_VIDEO_STREAM_POOL_ARN,
          SinkType: MediaStreamPipelineSinkType.KinesisVideoStreamPool,
        },
      ],
      Sources: [
        {
          SourceArn: `arn:aws:chime:${AWS_REGION}:${AWS_ACCOUNT}:meeting/${eventDetail.meetingId}`,
          SourceType: MediaPipelineSourceType.ChimeSdkMeeting,
        },
      ],
    };
    console.log(
      `CreateMediaStreamPipeline Params: ${JSON.stringify(params, null, 2)}`,
    );
    await chimeSdkMediaPipelinesClient.send(
      new CreateMediaStreamPipelineCommand(params),
    );
  } catch (error) {
    throw new Error(`Error starting Streaming Pipeline: ${error}`);
  }
}

async function startConsumer(consumerInfo: ConsumerInfo) {
  console.log('Starting Consumer');
  try {
    const response = await axios.post(
      `http://${KVS_CONSUMER_URL}/call`,
      consumerInfo,
    );
    console.log('POST request response:', response.data);
  } catch (error) {
    console.error('Error:', error);
    throw error;
  }
}
