/* eslint-disable import/no-extraneous-dependencies */
import { PassThrough, Readable } from 'stream';
import {
  BedrockRuntimeClient,
  InvokeModelCommand,
} from '@aws-sdk/client-bedrock-runtime';
import {
  ChimeSDKVoiceClient,
  UpdateSipMediaApplicationCallCommand,
} from '@aws-sdk/client-chime-sdk-voice';
import { DynamoDBClient, GetItemCommand } from '@aws-sdk/client-dynamodb';
import {
  KinesisVideoClient,
  GetDataEndpointCommand,
  APIName,
} from '@aws-sdk/client-kinesis-video';
import {
  KinesisVideoMedia,
  GetMediaCommandInput,
  StartSelectorType,
} from '@aws-sdk/client-kinesis-video-media';
import {
  TranscribeStreamingClient,
  StartStreamTranscriptionCommand,
  LanguageCode,
  MediaEncoding,
} from '@aws-sdk/client-transcribe-streaming';
import Fastify from 'fastify';
import ffmpeg from 'fluent-ffmpeg';

const fastify = Fastify({
  logger: true,
});

const REGION = process.env.REGION || 'us-east-1';
const SIP_MEDIA_APPLICATION_ID = process.env.SIP_MEDIA_APPLICATION_ID || '';
const MEETING_TABLE = process.env.MEETING_TABLE || '';
const BEDROCK_MODEL =
  process.env.BEDROCK_MODEL || 'anthropic.claude-instant-v1';

const bedrockClient = new BedrockRuntimeClient({
  region: REGION,
});
const ddbClient = new DynamoDBClient({ region: REGION });
const chimeSdkVoiceClient = new ChimeSDKVoiceClient({ region: REGION });

interface KVSStreamDetails {
  streamArn: string;
  meetingId: string;
}

interface Event {
  startFragmentNumber: string;
  meetingId: string;
  attendeeId: string;
  callStreamingStartTime: string;
  callerStreamArn: string;
}

fastify.post('/call', async (request, reply) => {
  try {
    const event = request.body as Event;
    console.log('EVENT:', JSON.stringify(event, null, 2));

    const streamArn = event.callerStreamArn;
    const meetingId = event.meetingId;
    console.log('Starting KVS Convert');
    await reply.send({
      message: 'Request received. Processing in progress...',
    });
    await readKVSConvertWriteAndTranscribe({
      streamArn,
      meetingId,
    });
    console.log('Streaming and conversion to PCM completed');
  } catch (error) {
    console.error('Error:', error);
    await reply.status(500).send({ error: 'Internal Server Error' });
  }
});

fastify.get('/', async (_request, reply) => {
  await reply.status(200).send('OK');
});

async function readKVSConvertWriteAndTranscribe({
  streamArn,
  meetingId,
}: KVSStreamDetails): Promise<void> {
  console.log('Initializing media stream client');
  const kvClient = new KinesisVideoClient({ region: REGION });
  const getDataCmd = new GetDataEndpointCommand({
    APIName: APIName.GET_MEDIA,
    StreamARN: streamArn,
  });

  console.log(`Fetching data endpoint: ${JSON.stringify(getDataCmd, null, 2)}`);
  const response = await kvClient.send(getDataCmd);
  console.log(`getDataCmd Response: ${JSON.stringify(response, null, 2)}`);
  const mediaClient = new KinesisVideoMedia({
    region: REGION,
    endpoint: response.DataEndpoint,
  });

  console.log('Setting up fragment selector');
  const fragmentSelector: GetMediaCommandInput = {
    StreamARN: streamArn,
    StartSelector: {
      StartSelectorType: StartSelectorType.NOW,
    },
  };
  console.log(`FragmentSelector: ${JSON.stringify(fragmentSelector, null, 2)}`);
  const result = await mediaClient.getMedia(fragmentSelector);
  const readableStream = (await result.Payload) as Readable;
  const outputStream = new PassThrough();

  ffmpeg(readableStream)
    // .on('stderr', (data) => {
    //   console.log(data);
    // })
    .audioCodec('libopus')
    .format('opus')
    .output(outputStream, { end: true })
    .run();

  startTranscription(outputStream, meetingId).catch((error) => {
    console.error('Transcription error:', error);
  });
}

const start = async () => {
  try {
    await fastify.listen({ port: 80, host: '0.0.0.0' });
  } catch (err) {
    fastify.log.error(err);
    process.exit(1);
  }
};
void start();

async function startTranscription(stream: Readable, meetingId: string) {
  const client = new TranscribeStreamingClient({ region: REGION });
  console.log('Starting Transcribe');

  const audioStream = async function* () {
    for await (const chunk of stream) {
      yield { AudioEvent: { AudioChunk: chunk } };
    }
  };

  try {
    const command = new StartStreamTranscriptionCommand({
      LanguageCode: LanguageCode.EN_US,
      MediaEncoding: MediaEncoding.OGG_OPUS,
      MediaSampleRateHertz: 48000,
      AudioStream: audioStream(),
    });

    const response = await client.send(command);

    if (response.TranscriptResultStream) {
      for await (const event of response.TranscriptResultStream) {
        console.log(event);
        if (
          event.TranscriptEvent &&
          event.TranscriptEvent &&
          event.TranscriptEvent.Transcript &&
          event.TranscriptEvent.Transcript.Results &&
          event.TranscriptEvent.Transcript.Results.length > 0 &&
          event.TranscriptEvent.Transcript.Results[0].IsPartial == false
        ) {
          console.log(
            'NonPartial Event: ',
            JSON.stringify(event.TranscriptEvent.Transcript),
          );
          const databaseResponse = await readMeetingInfoFromDB(meetingId);
          await updateSIPMediaApplication({
            transactionId: databaseResponse!.transactionId!.S!,
            action: 'Thinking',
          });
          const prompt = preparePrompt(
            event.TranscriptEvent.Transcript.Results[0].Alternatives![0]
              .Transcript!,
          );
          console.log('Prompt: ', prompt);
          const bedrockResponse = await bedrockClient.send(
            new InvokeModelCommand(prompt),
          );

          let text = JSON.parse(
            new TextDecoder().decode(bedrockResponse.body),
          ).completion;
          text = text.replace(/'/g, '’'); // Replacing ' with ’
          text = text.replace(/:/g, '.'); // Replacing : with .
          text = text.replace(/\n/g, ' '); // Remove \n
          console.log('Bedrock Text: ', text);

          await updateSIPMediaApplication({
            transactionId: databaseResponse!.transactionId!.S!,
            action: 'Response',
            text: text,
          });
        }
      }
    } else {
      console.error('TranscriptResultStream is undefined');
    }
  } catch (error) {
    console.error('Error in transcription:', error);
  }
}

function preparePrompt(promptRequest: string) {
  return {
    body: JSON.stringify({
      prompt:
        '\n\nHuman: This is a questions from a caller.  In a few sentences provide an answer to this question.\n\n' +
        promptRequest +
        '\n\nAssistant:',
      max_tokens_to_sample: 4000,
    }),
    modelId: BEDROCK_MODEL,
    accept: 'application/json',
    contentType: 'application/json',
  };
}

async function readMeetingInfoFromDB(meetingId: string) {
  const params = {
    TableName: MEETING_TABLE,
    Key: {
      meetingId: { S: meetingId },
    },
  };

  try {
    const data = await ddbClient.send(new GetItemCommand(params));
    if (data.Item) {
      console.log(`Retrieved meeting info for meetingId: ${meetingId}`);
      return data.Item;
    } else {
      console.log(`No meeting found for meetingId: ${meetingId}`);
      return null;
    }
  } catch (error) {
    console.error(`Error reading from DB: ${error}`);
    throw error;
  }
}

interface UpdateSIPMediaApplicationOptions {
  transactionId: string;
  action: string;
  text?: string;
}

async function updateSIPMediaApplication(
  options: UpdateSIPMediaApplicationOptions,
) {
  const { transactionId, action, text } = options;

  const params = {
    SipMediaApplicationId: SIP_MEDIA_APPLICATION_ID,
    TransactionId: transactionId,
    Arguments: { Function: action, ...(text ? { Text: text } : null) },
  };
  console.log(
    `Params for UpdateSipMediaApplicationCall: ${JSON.stringify(
      params,
      null,
      2,
    )}`,
  );
  try {
    await chimeSdkVoiceClient.send(
      new UpdateSipMediaApplicationCallCommand(params),
    );
  } catch (error) {
    console.error('Error Updating SIP Media Application: ', error);
    throw error;
  }
}
