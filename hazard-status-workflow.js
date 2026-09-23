// Pure orchestration for the non-transactional notify -> status sequence.
// The caller owns HTTP mapping; this module never sends mail or touches the DB itself.

class NotificationStatusPartialError extends Error {
  constructor(notification, cause) {
    super('notification sent but status update failed');
    this.name = 'NotificationStatusPartialError';
    this.code = 'partial-completion';
    this.notificationId = notification?.id ?? null;
    this.cause = cause;
  }
}

async function notifyThenPersistStatus({ notify, persist }) {
  const notification = await notify();
  try {
    const statusResult = await persist();
    return { notification, statusResult };
  } catch (cause) {
    throw new NotificationStatusPartialError(notification, cause);
  }
}

function partialCompletionBody(error) {  return {
    error: 'Notification sent but status update failed',
    code: 'partial-completion',
    notificationId: error?.notificationId ?? null,
  };
}

module.exports = {
  NotificationStatusPartialError,
  notifyThenPersistStatus,
  partialCompletionBody,
};
