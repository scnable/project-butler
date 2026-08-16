export interface CapabilityStatus {
  readonly supported: boolean;
  readonly minimumVersion?: string;
  readonly reason?: string;
}

export interface VscodeCapabilities {
  readonly vscodeVersion: string;
  readonly chatDisableAiFeatures: CapabilityStatus;
}

export interface VscodeCapabilityRegistrations {
  readonly chatDisableAiFeatures: boolean;
}

export function resolveVscodeCapabilities(
  vscodeVersion: string,
  registrations: VscodeCapabilityRegistrations,
): VscodeCapabilities {
  const chatSettingSupported = registrations.chatDisableAiFeatures;
  return {
    vscodeVersion,
    chatDisableAiFeatures: chatSettingSupported
      ? { supported: true, minimumVersion: '1.104.0' }
      : {
        supported: false,
        minimumVersion: '1.104.0',
        reason: '当前 VS Code 未注册 chat.disableAIFeatures，需要 VS Code 1.104 或更高版本。',
      },
  };
}

export function isRegisteredCommand(
  command: string,
  registeredCommands: readonly string[],
): boolean {
  return command.trim().length > 0 && registeredCommands.includes(command);
}
