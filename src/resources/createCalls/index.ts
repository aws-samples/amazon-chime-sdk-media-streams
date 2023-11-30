/* eslint-disable import/no-extraneous-dependencies */
import {
  ChimeSDKVoiceClient,
  CreateSipMediaApplicationCallCommand,
} from '@aws-sdk/client-chime-sdk-voice';
import { APIGatewayProxyResult, APIGatewayEvent } from 'aws-lambda';

var chimeSDKVoiceClient = new ChimeSDKVoiceClient({ region: 'us-east-1' });

const FROM_NUMBER = process.env.FROM_NUMBER;
const SIP_MEDIA_APPLICATION_ID = process.env.SIP_MEDIA_APPLICATION_ID || '';

var response = {
  statusCode: 0,
  body: '',
  headers: {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Content-Type': 'application/json',
  },
};

export const handler = async (
  event: APIGatewayEvent,
): Promise<APIGatewayProxyResult> => {
  console.info(event);

  switch (event.path) {
    case '/meeting':
      const toNumber: string = event.body || '';
      await executeDial(toNumber);
      response.statusCode = 200;
      return response;
    default:
      return response;
  }
};

async function executeDial(toNumber: string) {
  var params = {
    FromPhoneNumber: FROM_NUMBER,
    SipMediaApplicationId: SIP_MEDIA_APPLICATION_ID,
    ToPhoneNumber: toNumber,
  };
  console.info('Dial Params: ' + JSON.stringify(params));
  try {
    const dialInfo = await chimeSDKVoiceClient.send(
      new CreateSipMediaApplicationCallCommand(params),
    );
    return dialInfo;
  } catch (error) {
    console.info(`Error: ${error}`);
    throw error;
  }
}
