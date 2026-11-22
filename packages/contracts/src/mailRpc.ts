import * as Rpc from "effect/rpc/Rpc";
import * as Schema from "effect/Schema";

import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  AuthSettingsWriteScope,
  EnvironmentAuthorizationError,
} from "./auth.ts";
import {
  MailAccount,
  MailAccountInput,
  MailActInput,
  MailActionPage,
  MailActResult,
  MailAddAccountInput,
  MailDismissRecapInput,
  MailDraft,
  MailDraftInput,
  MailDryRunRuleInput,
  MailDryRunRuleResult,
  MailEmailMd,
  MailError,
  MailListActionsInput,
  MailListSettledInput,
  MailOpenSessionInput,
  MailOpenSessionResult,
  MailSaveDraftInput,
  MailSearchInput,
  MailSearchResult,
  MailSeedVoiceResult,
  MailSendDraftInput,
  MailSettings,
  MailSetTrustInput,
  MailStreamEvent,
  MailSyncInput,
  MailThreadDetail,
  MailThreadInput,
  MailThreadPage,
  MailTrustList,
  MailUndoInput,
  MailUpdateAccountInput,
  MailUpdateSettingsInput,
  MailWriteEmailMdInput,
} from "./mail.ts";

export const MAIL_WS_METHODS = {
  mailSubscribe: "mail.subscribe",
  mailGetThread: "mail.getThread",
  mailListSettled: "mail.listSettled",
  mailSearch: "mail.search",
  mailAct: "mail.act",
  mailUndo: "mail.undo",
  mailListActions: "mail.listActions",
  mailSaveDraft: "mail.saveDraft",
  mailDiscardDraft: "mail.discardDraft",
  mailSendDraft: "mail.sendDraft",
  mailOpenSession: "mail.openSession",
  mailAddAccount: "mail.addAccount",
  mailUpdateAccount: "mail.updateAccount",
  mailRemoveAccount: "mail.removeAccount",
  mailSyncNow: "mail.syncNow",
  mailUpdateSettings: "mail.updateSettings",
  mailListTrust: "mail.listTrust",
  mailSetTrust: "mail.setTrust",
  mailReadEmailMd: "mail.readEmailMd",
  mailWriteEmailMd: "mail.writeEmailMd",
  mailDryRunRule: "mail.dryRunRule",
  mailSeedVoice: "mail.seedVoice",
  mailDismissRecap: "mail.dismissRecap",
} as const;

const error = Schema.Union([MailError, EnvironmentAuthorizationError]);

export const MailRpcs = [
  Rpc.make(MAIL_WS_METHODS.mailSubscribe, {
    payload: Schema.Struct({}),
    success: MailStreamEvent,
    error,
    stream: true,
  }),
  Rpc.make(MAIL_WS_METHODS.mailGetThread, {
    payload: MailThreadInput,
    success: MailThreadDetail,
    error,
  }),
  Rpc.make(MAIL_WS_METHODS.mailListSettled, {
    payload: MailListSettledInput,
    success: MailThreadPage,
    error,
  }),
  Rpc.make(MAIL_WS_METHODS.mailSearch, {
    payload: MailSearchInput,
    success: MailSearchResult,
    error,
  }),
  Rpc.make(MAIL_WS_METHODS.mailAct, { payload: MailActInput, success: MailActResult, error }),
  Rpc.make(MAIL_WS_METHODS.mailUndo, { payload: MailUndoInput, error }),
  Rpc.make(MAIL_WS_METHODS.mailListActions, {
    payload: MailListActionsInput,
    success: MailActionPage,
    error,
  }),
  Rpc.make(MAIL_WS_METHODS.mailSaveDraft, {
    payload: MailSaveDraftInput,
    success: MailDraft,
    error,
  }),
  Rpc.make(MAIL_WS_METHODS.mailDiscardDraft, { payload: MailDraftInput, error }),
  Rpc.make(MAIL_WS_METHODS.mailSendDraft, {
    payload: MailSendDraftInput,
    success: MailDraft,
    error,
  }),
  Rpc.make(MAIL_WS_METHODS.mailOpenSession, {
    payload: MailOpenSessionInput,
    success: MailOpenSessionResult,
    error,
  }),
  Rpc.make(MAIL_WS_METHODS.mailAddAccount, {
    payload: MailAddAccountInput,
    success: MailAccount,
    error,
  }),
  Rpc.make(MAIL_WS_METHODS.mailUpdateAccount, {
    payload: MailUpdateAccountInput,
    success: MailAccount,
    error,
  }),
  Rpc.make(MAIL_WS_METHODS.mailRemoveAccount, { payload: MailAccountInput, error }),
  Rpc.make(MAIL_WS_METHODS.mailSyncNow, { payload: MailSyncInput, error }),
  Rpc.make(MAIL_WS_METHODS.mailUpdateSettings, {
    payload: MailUpdateSettingsInput,
    success: MailSettings,
    error,
  }),
  Rpc.make(MAIL_WS_METHODS.mailListTrust, {
    payload: Schema.Struct({}),
    success: MailTrustList,
    error,
  }),
  Rpc.make(MAIL_WS_METHODS.mailSetTrust, { payload: MailSetTrustInput, error }),
  Rpc.make(MAIL_WS_METHODS.mailReadEmailMd, {
    payload: Schema.Struct({}),
    success: MailEmailMd,
    error,
  }),
  Rpc.make(MAIL_WS_METHODS.mailWriteEmailMd, {
    payload: MailWriteEmailMdInput,
    success: MailEmailMd,
    error,
  }),
  Rpc.make(MAIL_WS_METHODS.mailDryRunRule, {
    payload: MailDryRunRuleInput,
    success: MailDryRunRuleResult,
    error,
  }),
  Rpc.make(MAIL_WS_METHODS.mailSeedVoice, {
    payload: Schema.Struct({}),
    success: MailSeedVoiceResult,
    error,
  }),
  Rpc.make(MAIL_WS_METHODS.mailDismissRecap, { payload: MailDismissRecapInput, error }),
] as const;

/** Reading mail is reading the environment's data. */
export const MAIL_READ_RPC_SCOPES = {
  [MAIL_WS_METHODS.mailSubscribe]: AuthOrchestrationReadScope,
  [MAIL_WS_METHODS.mailGetThread]: AuthOrchestrationReadScope,
  [MAIL_WS_METHODS.mailListSettled]: AuthOrchestrationReadScope,
  [MAIL_WS_METHODS.mailSearch]: AuthOrchestrationReadScope,
  [MAIL_WS_METHODS.mailListActions]: AuthOrchestrationReadScope,
  [MAIL_WS_METHODS.mailListTrust]: AuthOrchestrationReadScope,
  [MAIL_WS_METHODS.mailReadEmailMd]: AuthOrchestrationReadScope,
  [MAIL_WS_METHODS.mailDryRunRule]: AuthOrchestrationReadScope,
} as const;

/** Acting on mail operates the environment; accounts, trust and EMAIL.md are settings. */
export const MAIL_RPC_SCOPES = {
  [MAIL_WS_METHODS.mailAct]: AuthOrchestrationOperateScope,
  [MAIL_WS_METHODS.mailUndo]: AuthOrchestrationOperateScope,
  [MAIL_WS_METHODS.mailSaveDraft]: AuthOrchestrationOperateScope,
  [MAIL_WS_METHODS.mailDiscardDraft]: AuthOrchestrationOperateScope,
  [MAIL_WS_METHODS.mailSendDraft]: AuthOrchestrationOperateScope,
  [MAIL_WS_METHODS.mailOpenSession]: AuthOrchestrationOperateScope,
  [MAIL_WS_METHODS.mailSyncNow]: AuthOrchestrationOperateScope,
  [MAIL_WS_METHODS.mailDismissRecap]: AuthOrchestrationOperateScope,
  [MAIL_WS_METHODS.mailSeedVoice]: AuthOrchestrationOperateScope,
  [MAIL_WS_METHODS.mailAddAccount]: AuthSettingsWriteScope,
  [MAIL_WS_METHODS.mailUpdateAccount]: AuthSettingsWriteScope,
  [MAIL_WS_METHODS.mailRemoveAccount]: AuthSettingsWriteScope,
  [MAIL_WS_METHODS.mailUpdateSettings]: AuthSettingsWriteScope,
  [MAIL_WS_METHODS.mailSetTrust]: AuthSettingsWriteScope,
  [MAIL_WS_METHODS.mailWriteEmailMd]: AuthSettingsWriteScope,
} as const;
