import { PreSignUpTriggerEvent, Context, Callback } from 'aws-lambda';

const allowedDomain: string | undefined = process.env.ALLOWED_DOMAIN;

exports.handler = async (
  event: PreSignUpTriggerEvent,
  _context: Context,
  callback: Callback,
): Promise<void> => {
  const userEmail: string = event.request.userAttributes.email;
  const userEmailDomain: string = userEmail.split('@')[0];

  if (
    userEmailDomain === allowedDomain ||
    !allowedDomain ||
    allowedDomain.length === 0
  ) {
    callback(null, event);
  } else {
    const error: Error = new Error(
      `Cannot authenticate users from domains different from ${allowedDomain}`,
    );
    callback(error, event);
  }
};
