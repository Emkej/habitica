import nconf from 'nconf';
import { model as User } from '../../models/user';

import ChatReporter from './chatReporter';
import {
  NotFound,
} from '../errors';
import { getGroupUrl, sendTxn } from '../email';
import slack from '../slack';
import apiError from '../apiError';

import _find from 'lodash/find';

const FLAG_REPORT_EMAILS = nconf.get('FLAG_REPORT_EMAIL').split(',').map((email) => {
  return { email, canSend: true };
});

export default class InboxChatReporter extends ChatReporter {
  constructor (req, res) {
    super(req, res);

    this.reporter = res.locals.user;
    this.inboxUser = res.locals.user;
  }

  async validate () {
    this.req.checkParams('messageId', apiError('messageIdRequired')).notEmpty();

    let validationErrors = this.req.validationErrors();
    if (validationErrors) throw validationErrors;

    if (this.reporter.contributor.admin && this.req.query.userId) {
      this.inboxUser = await User.findOne({_id: this.req.query.userId});
    }

    let messages = this.inboxUser.inbox.messages;

    const message = _find(messages, (m) => m.id === this.req.params.messageId);
    if (!message) throw new NotFound(this.res.t('messageGroupChatNotFound'));

    const userComment = this.req.body.comment;

    return {message, userComment};
  }

  async notify (message, userComment) {
    const group = {
      type: 'private messages',
    };

    await super.notify(group, message);

    const groupUrl = getGroupUrl(group);
    sendTxn(FLAG_REPORT_EMAILS, 'flag-report-to-mods-with-comments', this.emailVariables.concat([
      {name: 'GROUP_NAME', content: group.name},
      {name: 'GROUP_TYPE', content: group.type},
      {name: 'GROUP_ID', content: group._id},
      {name: 'GROUP_URL', content: groupUrl},
      {name: 'REPORTER_COMMENT', content: userComment || ''},
    ]));

    slack.sendInboxFlagNotification({
      authorEmail: this.authorEmail,
      flagger: this.reporter,
      message,
      userComment,
    });
  }

  updateMessageAndSave (message, updateFunc) {
    updateFunc(message);

    this.inboxUser.inbox.messages[message.id] = message;
    this.inboxUser.markModified('inbox.messages');

    return this.inboxUser.save();
  }

  flagInboxMessage (message) {
    // Log user ids that have flagged the message
    if (!message.flags) message.flags = {};
    // TODO fix error type
    if (message.flags[this.reporter._id] && !this.reporter.contributor.admin) {
      throw new NotFound(this.res.t('messageGroupChatFlagAlreadyReported'));
    }

    return this.updateMessageAndSave(message, (m) => {
      m.flags[this.reporter._id] = true;

      // Log total number of flags (publicly viewable)
      if (!m.flagCount) m.flagCount = 0;
      if (this.reporter.contributor.admin) {
        // Arbitrary amount, higher than 2
        m.flagCount = 5;
      } else {
        m.flagCount++;
      }
    });
  }

  async markMessageAsReported (message) {
    return this.updateMessageAndSave(message, (m) => {
      m.reported = true;
    });
  }

  async flag () {
    let {message, userComment} = await this.validate();
    await this.flagInboxMessage(message);
    await this.notify(message, userComment);
    await this.markMessageAsReported(message);
    return message;
  }
}
