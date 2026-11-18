const driver = require('./gemini-driver');
const profileManager = require('./profile-manager');

module.exports = {
  sendPrompt: driver.sendPrompt,
  ModelUnavailable: driver.ModelUnavailable,
  selectModelAndThinking: driver.selectModelAndThinking,
  listConversations: driver.listConversations,
  getConversationTranscript: driver.getConversationTranscript,
  deleteConversation: driver.deleteConversation,
  deleteConversationInternal: driver.deleteConversationInternal,
  ensureChrome: driver.ensureChrome,
  stopChrome: driver.stopChrome,
  isCdpReady: driver.isCdpReady,
  getRunningChromeMode: driver.getRunningChromeMode,
  getRunningChromeProfile: driver.getRunningChromeProfile,
  getBrowserStatus: driver.getBrowserStatus,
  attachFile: driver.attachFile,
  downloadGeneratedMedia: driver.downloadGeneratedMedia,
  dismissOverlays: driver.dismissOverlays,
  getUploadToolsButton: driver.getUploadToolsButton,
  checkRobotVerification: driver.checkRobotVerification,
  captureUsageLimits: driver.captureUsageLimits,
  parseUsageLimits: driver.parseUsageLimits,
  extractWrbFrames: driver.extractWrbFrames,
  findMetricRecords: driver.findMetricRecords,
  readAccountsUsage: driver.readAccountsUsage,
  updateAccountUsage: driver.updateAccountUsage,
  usageLimits: driver.usageLimits,
  profileManager
};
