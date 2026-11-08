import { Tool, RiskLevel } from '../Tool.js';
import { DeviceRiskLevel } from '../../devices/DeviceManager.js';
import { ComputerUseEngine } from '../../devices/ComputerUseEngine.js';

/**
 * Device Operating Layer tools — spec sections 3/8/9/10/17/23. These are the
 * ONLY way anything in XOFT touches a connected phone/laptop. Deliberately
 * an allowlist of specific capability-scoped actions, never a general
 * `execute_shell_command` tool (spec section 17 is explicit about this).
 *
 * Each tool's execute() calls deviceManager.execute(...), which queues a
 * command and genuinely waits for the real device agent (see
 * docs/MOBILE_COMPANION_CONTRACT.md) to report a result. If no agent is
 * connected/online, this throws a real timeout error — it does not pretend
 * to have opened an app, moved a file, etc. Status is PARTIALLY_IMPLEMENTED:
 * the routing/queueing/verification pipeline is real and fully working; the
 * remaining gap is a native agent to actually receive and act on commands,
 * which is a separate codebase per the mobile companion contract.
 */
export function buildDeviceTools({ deviceManager, visionInterpreter, activityLog }) {
  const computerUse = visionInterpreter ? new ComputerUseEngine({ deviceManager, visionInterpreter, activityLog }) : null;
  const status = 'PARTIALLY_IMPLEMENTED';
  const deviceIdProp = { deviceId: { type: 'string', description: 'Target device id from GET /api/devices' } };

  return [
    new Tool({
      name: 'device_get_state',
      description: "Read a connected device's current state (battery, network, active application, lock state).",
      inputSchema: { type: 'object', properties: { ...deviceIdProp }, required: ['deviceId'] },
      riskLevel: RiskLevel.SAFE,
      status,
      execute: async ({ deviceId }) =>
        deviceManager.execute({ deviceId, capability: 'system', action: 'read_system_info', riskLevel: DeviceRiskLevel.LOW }),
    }),

    new Tool({
      name: 'device_list_apps',
      description: 'List applications currently running or available on a connected device.',
      inputSchema: { type: 'object', properties: { ...deviceIdProp }, required: ['deviceId'] },
      requiredPermissions: ['apps.list'],
      riskLevel: RiskLevel.SAFE,
      status,
      execute: async ({ deviceId }) =>
        deviceManager.execute({ deviceId, capability: 'applications', action: 'list', riskLevel: DeviceRiskLevel.LOW }),
    }),

    new Tool({
      name: 'device_launch_app',
      description: 'Open/launch a permitted application on a connected device (e.g. Chrome, VS Code).',
      inputSchema: {
        type: 'object',
        properties: { ...deviceIdProp, application: { type: 'string' } },
        required: ['deviceId', 'application'],
      },
      requiredPermissions: ['apps.launch'],
      riskLevel: RiskLevel.LOW,
      status,
      execute: async ({ deviceId, application }) =>
        deviceManager.execute({
          deviceId,
          capability: 'applications',
          action: 'open_application',
          parameters: { application },
          riskLevel: DeviceRiskLevel.LOW,
          idempotencyKey: `launch:${deviceId}:${application}`,
        }),
    }),

    new Tool({
      name: 'device_close_app',
      description: 'Close a running application on a connected device, where the OS permits it.',
      inputSchema: {
        type: 'object',
        properties: { ...deviceIdProp, application: { type: 'string' } },
        required: ['deviceId', 'application'],
      },
      requiredPermissions: ['apps.close'],
      riskLevel: RiskLevel.LOW,
      status,
      execute: async ({ deviceId, application }) =>
        deviceManager.execute({ deviceId, capability: 'applications', action: 'close_application', parameters: { application }, riskLevel: DeviceRiskLevel.LOW }),
    }),

    new Tool({
      name: 'device_open_url',
      description: "Open a URL in the device's default browser.",
      inputSchema: {
        type: 'object',
        properties: { ...deviceIdProp, url: { type: 'string' } },
        required: ['deviceId', 'url'],
      },
      requiredPermissions: ['screen.interact'],
      riskLevel: RiskLevel.LOW,
      status,
      execute: async ({ deviceId, url }) =>
        deviceManager.execute({ deviceId, capability: 'browser', action: 'open_url', parameters: { url }, riskLevel: DeviceRiskLevel.LOW }),
    }),

    // BrowserController already implements CDP tab management, safe navigation,
    // DOM inspection, verified interaction and screenshots on the paired PC agent.
    // These tools expose that real capability to XOFT's planner/model layer.
    new Tool({
      name: 'device_browser_list_tabs',
      description: 'List open browser tabs on a paired device, including each tab title, URL and attached state.',
      inputSchema: { type: 'object', properties: { ...deviceIdProp }, required: ['deviceId'] },
      requiredPermissions: ['browser.read'], riskLevel: RiskLevel.SAFE, status,
      execute: async ({ deviceId }) => deviceManager.execute({ deviceId, capability: 'browser', action: 'list_tabs', riskLevel: DeviceRiskLevel.LOW }),
    }),

    new Tool({
      name: 'device_browser_get_page',
      description: 'Read the current browser tab URL, title, ready state and element counts.',
      inputSchema: { type: 'object', properties: { ...deviceIdProp }, required: ['deviceId'] },
      requiredPermissions: ['browser.read'], riskLevel: RiskLevel.SAFE, status,
      execute: async ({ deviceId }) => deviceManager.execute({ deviceId, capability: 'browser', action: 'get_page', riskLevel: DeviceRiskLevel.LOW }),
    }),

    new Tool({
      name: 'device_browser_get_dom',
      description: 'Inspect a structured, secret-redacted snapshot of links, buttons, inputs and forms on the current browser page.',
      inputSchema: { type: 'object', properties: { ...deviceIdProp, limit: { type: 'integer', minimum: 1, maximum: 400 } }, required: ['deviceId'] },
      requiredPermissions: ['browser.read'], riskLevel: RiskLevel.SAFE, status,
      execute: async ({ deviceId, limit = 150 }) => deviceManager.execute({ deviceId, capability: 'browser', action: 'get_dom', parameters: { limit }, riskLevel: DeviceRiskLevel.LOW }),
    }),

    new Tool({
      name: 'device_browser_get_text',
      description: 'Read visible page text or the text of one element. Password and other secret fields are redacted by the browser agent.',
      inputSchema: { type: 'object', properties: { ...deviceIdProp, locator: { type: 'object', properties: { selector: { type: 'string' }, text: { type: 'string' }, index: { type: 'integer', minimum: 0 } } }, maxChars: { type: 'integer', minimum: 1, maximum: 20000 } }, required: ['deviceId'] },
      requiredPermissions: ['browser.read'], riskLevel: RiskLevel.SAFE, status,
      execute: async ({ deviceId, locator, maxChars = 12000 }) => deviceManager.execute({ deviceId, capability: 'browser', action: 'get_text', parameters: { locator: locator ?? null, maxChars }, riskLevel: DeviceRiskLevel.LOW }),
    }),

    new Tool({
      name: 'device_browser_navigate',
      description: 'Navigate the paired device browser to a normal HTTP(S) website. URL policy and browser security checks are enforced on the device.',
      inputSchema: { type: 'object', properties: { ...deviceIdProp, url: { type: 'string', maxLength: 2048 } }, required: ['deviceId', 'url'] },
      requiredPermissions: ['browser.navigate'], riskLevel: RiskLevel.LOW, status,
      execute: async ({ deviceId, url }) => deviceManager.execute({ deviceId, capability: 'browser', action: 'navigate', parameters: { url }, riskLevel: DeviceRiskLevel.LOW }),
    }),

    new Tool({
      name: 'device_browser_click',
      description: 'Click one visible browser element by CSS selector or exact visible text. Covered or disabled elements are refused unless a human acts directly.',
      inputSchema: { type: 'object', properties: { ...deviceIdProp, locator: { type: 'object', properties: { selector: { type: 'string', maxLength: 500 }, text: { type: 'string', maxLength: 200 }, index: { type: 'integer', minimum: 0 } } } }, required: ['deviceId', 'locator'] },
      requiredPermissions: ['browser.interact'], riskLevel: RiskLevel.LOW, status,
      execute: async ({ deviceId, locator }) => deviceManager.execute({ deviceId, capability: 'browser', action: 'click', parameters: { locator }, riskLevel: DeviceRiskLevel.LOW }),
    }),

    new Tool({
      name: 'device_browser_fill',
      description: 'Fill a browser input identified by CSS selector or visible text, then read its value back to verify the fill. Secret fields remain redacted.',
      inputSchema: { type: 'object', properties: { ...deviceIdProp, locator: { type: 'object', properties: { selector: { type: 'string', maxLength: 500 }, text: { type: 'string', maxLength: 200 }, index: { type: 'integer', minimum: 0 } } }, text: { type: 'string', maxLength: 5000 } }, required: ['deviceId', 'locator', 'text'] },
      requiredPermissions: ['browser.interact'], riskLevel: RiskLevel.LOW, status,
      execute: async ({ deviceId, locator, text }) => deviceManager.execute({ deviceId, capability: 'browser', action: 'fill', parameters: { locator, text }, riskLevel: DeviceRiskLevel.LOW }),
    }),

    new Tool({
      name: 'device_browser_wait_for',
      description: 'Wait for a browser element to become attached, visible, hidden or detached before continuing.',
      inputSchema: { type: 'object', properties: { ...deviceIdProp, locator: { type: 'object', properties: { selector: { type: 'string', maxLength: 500 }, text: { type: 'string', maxLength: 200 }, index: { type: 'integer', minimum: 0 } } }, state: { type: 'string', enum: ['attached', 'visible', 'hidden', 'detached'] }, timeoutMs: { type: 'integer', minimum: 100, maximum: 30000 } }, required: ['deviceId', 'locator'] },
      requiredPermissions: ['browser.read'], riskLevel: RiskLevel.SAFE, status,
      execute: async ({ deviceId, locator, state = 'visible', timeoutMs = 10000 }) => deviceManager.execute({ deviceId, capability: 'browser', action: 'wait_for', parameters: { locator, state, timeoutMs }, riskLevel: DeviceRiskLevel.LOW }),
    }),

    new Tool({
      name: 'device_browser_screenshot',
      description: 'Capture the current browser tab or full page as an image for visual inspection.',
      inputSchema: { type: 'object', properties: { ...deviceIdProp, fullPage: { type: 'boolean' } }, required: ['deviceId'] },
      requiredPermissions: ['browser.read'], riskLevel: RiskLevel.SAFE, status,
      execute: async ({ deviceId, fullPage = false }) => deviceManager.execute({ deviceId, capability: 'browser', action: 'screenshot', parameters: { fullPage }, riskLevel: DeviceRiskLevel.LOW }),
    }),

    new Tool({
      name: 'device_browser_new_tab',
      description: 'Open a new browser tab at a supplied HTTP(S) URL or about:blank.',
      inputSchema: { type: 'object', properties: { ...deviceIdProp, url: { type: 'string', maxLength: 2048 } }, required: ['deviceId'] },
      requiredPermissions: ['browser.navigate'], riskLevel: RiskLevel.LOW, status,
      execute: async ({ deviceId, url = 'about:blank' }) => deviceManager.execute({ deviceId, capability: 'browser', action: 'new_tab', parameters: { url }, riskLevel: DeviceRiskLevel.LOW }),
    }),

    new Tool({
      name: 'device_browser_press',
      description: 'Press a supported keyboard key in the current browser tab (for example Enter, Tab, Escape or an arrow key).',
      inputSchema: { type: 'object', properties: { ...deviceIdProp, key: { type: 'string', enum: ['Enter', 'Tab', 'Escape', 'Backspace', 'Delete', 'Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End', 'PageUp', 'PageDown'] } }, required: ['deviceId', 'key'] },
      requiredPermissions: ['browser.interact'], riskLevel: RiskLevel.LOW, status,
      execute: async ({ deviceId, key }) => deviceManager.execute({ deviceId, capability: 'browser', action: 'press', parameters: { key }, riskLevel: DeviceRiskLevel.LOW }),
    }),

    new Tool({
      name: 'device_list_files',
      description: 'List files in a permitted directory on a connected device. Never reaches outside permitted/allowlisted paths.',
      inputSchema: {
        type: 'object',
        properties: { ...deviceIdProp, path: { type: 'string' } },
        required: ['deviceId', 'path'],
      },
      requiredPermissions: ['files.read'],
      riskLevel: RiskLevel.LOW,
      status,
      execute: async ({ deviceId, path: targetPath }) =>
        deviceManager.execute({ deviceId, capability: 'files', action: 'list_files', parameters: { path: targetPath }, riskLevel: DeviceRiskLevel.LOW }),
    }),

    new Tool({
      name: 'device_transfer_file',
      description: 'Transfer a file from one connected device to another (e.g. laptop to phone). Requires both devices online and paired.',
      inputSchema: {
        type: 'object',
        properties: {
          sourceDeviceId: { type: 'string' },
          targetDeviceId: { type: 'string' },
          filePath: { type: 'string' },
        },
        required: ['sourceDeviceId', 'targetDeviceId', 'filePath'],
      },
      requiredPermissions: ['files.read', 'files.write'],
      riskLevel: RiskLevel.EXTERNAL, // crosses a device boundary — approval required by default
      status,
      execute: async ({ sourceDeviceId, targetDeviceId, filePath }) => {
        // Two coordinated device commands, not one — spec section 19. Read
        // from source first; only queue the write to target if the source
        // step genuinely reported success (real coordination, not a
        // fire-and-forget pair of calls).
        const readResult = await deviceManager.execute({
          deviceId: sourceDeviceId,
          capability: 'files',
          action: 'prepare_transfer',
          parameters: { path: filePath },
          riskLevel: DeviceRiskLevel.MEDIUM,
        });
        if (!readResult.success) {
          return { success: false, error: `Could not read '${filePath}' from source device.`, sourceResult: readResult };
        }
        const writeResult = await deviceManager.execute({
          deviceId: targetDeviceId,
          capability: 'files',
          action: 'receive_transfer',
          parameters: { path: filePath, sourceDeviceId, sourceData: readResult.result },
          riskLevel: DeviceRiskLevel.MEDIUM,
        });
        return { success: writeResult.success, sourceResult: readResult, targetResult: writeResult };
      },
    }),

    new Tool({
      name: 'device_screen_capture',
      description: 'Capture the current screen of a connected device for authorized visual understanding.',
      inputSchema: { type: 'object', properties: { ...deviceIdProp }, required: ['deviceId'] },
      requiredPermissions: ['screen.capture'], riskLevel: RiskLevel.LOW, status,
      execute: async ({ deviceId }) => deviceManager.execute({ deviceId, capability: 'screen', action: 'capture', riskLevel: DeviceRiskLevel.LOW }),
    }),

    new Tool({
      name: 'device_screen_click',
      description: 'Click an authorized screen coordinate on a connected desktop device.',
      inputSchema: { type: 'object', properties: { ...deviceIdProp, x: { type: 'number' }, y: { type: 'number' }, button: { type: 'string', enum: ['left','right'] } }, required: ['deviceId','x','y'] },
      requiredPermissions: ['screen.interact'], riskLevel: RiskLevel.LOW, status,
      execute: async ({ deviceId, x, y, button = 'left' }) => deviceManager.execute({ deviceId, capability: 'screen', action: 'click', parameters: { x, y, button }, riskLevel: DeviceRiskLevel.LOW }),
    }),

    new Tool({
      name: 'device_screen_type',
      description: 'Type text into the currently focused application on a connected desktop device.',
      inputSchema: { type: 'object', properties: { ...deviceIdProp, text: { type: 'string', maxLength: 4000 } }, required: ['deviceId','text'] },
      requiredPermissions: ['screen.interact'], riskLevel: RiskLevel.LOW, status,
      execute: async ({ deviceId, text }) => deviceManager.execute({ deviceId, capability: 'screen', action: 'type', parameters: { text }, riskLevel: DeviceRiskLevel.LOW }),
    }),

    new Tool({
      name: 'device_screen_scroll',
      description: 'Scroll an authorized desktop screen.',
      inputSchema: { type: 'object', properties: { ...deviceIdProp, amount: { type: 'integer', minimum: -20, maximum: 20 } }, required: ['deviceId','amount'] },
      requiredPermissions: ['screen.interact'], riskLevel: RiskLevel.LOW, status,
      execute: async ({ deviceId, amount }) => deviceManager.execute({ deviceId, capability: 'screen', action: 'scroll', parameters: { amount }, riskLevel: DeviceRiskLevel.LOW }),
    }),

    new Tool({
      name: 'device_screen_understand',
      description:
        "Capture a connected device's screen AND interpret it: returns the application/window, a list of visible UI elements, and a plain-language summary — instead of raw image bytes. Use this when you need to know what is actually on screen before deciding an action, not just that a capture succeeded.",
      inputSchema: {
        type: 'object',
        properties: { ...deviceIdProp, question: { type: 'string', description: 'Optional specific question to answer about what is on screen.' } },
        required: ['deviceId'],
      },
      requiredPermissions: ['screen.capture'],
      riskLevel: RiskLevel.LOW,
      status: visionInterpreter ? status : 'BLOCKED',
      execute: async ({ deviceId, question }) => {
        if (!visionInterpreter) {
          return { success: false, error: 'No vision-capable provider is configured (set ANTHROPIC_API_KEY or OPENAI_API_KEY).' };
        }
        const capture = await deviceManager.execute({ deviceId, capability: 'screen', action: 'capture', riskLevel: DeviceRiskLevel.LOW });
        if (!capture?.success || !capture?.result?.data?.base64) {
          return { success: false, error: 'Screen capture did not return image data.', captureResult: capture };
        }
        try {
          const interpretation = await visionInterpreter.interpretScreenshot({
            base64: capture.result.data.base64,
            mimeType: capture.result.data.mimeType,
            question,
          });
          return { success: true, capture: { verification: capture.result.verification }, interpretation };
        } catch (err) {
          return { success: false, error: `Vision interpretation failed: ${err.message}`, captureResult: capture };
        }
      },
    }),

    new Tool({
      name: 'device_restart_app',
      description: 'Restart a permitted application after a failure. XOFT may use this as a bounded self-healing action before retrying a task.',
      inputSchema: { type: 'object', properties: { ...deviceIdProp, application: { type: 'string' } }, required: ['deviceId', 'application'] },
      requiredPermissions: ['apps.restart'], riskLevel: RiskLevel.LOW, status,
      execute: async ({ deviceId, application }) => deviceManager.execute({ deviceId, capability: 'applications', action: 'restart_application', parameters: { application }, riskLevel: DeviceRiskLevel.LOW }),
    }),

    new Tool({
      name: 'device_social_post',
      description: 'Publish a social-media post through an explicitly paired device and its permitted social/browser capability. Requires user approval because it publishes externally.',
      inputSchema: { type: 'object', properties: { ...deviceIdProp, platform: { type: 'string', enum: ['facebook','instagram','x','linkedin','tiktok','threads','other'] }, text: { type: 'string', maxLength: 10000 }, media: { type: 'array', items: { type: 'string' } } }, required: ['deviceId', 'platform', 'text'] },
      requiredPermissions: ['social.post'], riskLevel: RiskLevel.EXTERNAL, status,
      execute: async ({ deviceId, platform, text, media = [] }) => deviceManager.execute({ deviceId, capability: 'social', action: 'publish_post', parameters: { platform, text, media }, riskLevel: DeviceRiskLevel.MEDIUM }),
    }),

    new Tool({
      name: 'device_social_open',
      description: 'Open a supported social-media platform on a paired device so XOFT can prepare an authorized posting workflow.',
      inputSchema: { type: 'object', properties: { ...deviceIdProp, platform: { type: 'string' } }, required: ['deviceId', 'platform'] },
      requiredPermissions: ['social.open'], riskLevel: RiskLevel.LOW, status,
      execute: async ({ deviceId, platform }) => deviceManager.execute({ deviceId, capability: 'social', action: 'open', parameters: { platform }, riskLevel: DeviceRiskLevel.LOW }),
    }),

    new Tool({
      name: 'device_computer_use',
      description: 'Perform a bounded natural-language computer-use action on a paired device, such as finding a visible button, clicking it, typing into a field, scrolling, or navigating a UI. The native device agent must support the computer_use capability. The action must stay within the supplied instruction and maxActions.',
      inputSchema: {
        type: 'object',
        properties: {
          ...deviceIdProp,
          instruction: { type: 'string', maxLength: 4000 },
          expectedOutcome: { type: 'string', maxLength: 1000 },
          maxActions: { type: 'integer', minimum: 1, maximum: 12 },
        },
        required: ['deviceId', 'instruction'],
      },
      requiredPermissions: ['computer.use'],
      riskLevel: RiskLevel.LOW,
      status: computerUse ? status : 'BLOCKED',
      execute: async ({ deviceId, instruction, expectedOutcome, maxActions = 6 }) => {
        if (!computerUse) return { success: false, error: 'Computer use requires a configured vision-capable provider.' };
        return computerUse.run({ deviceId, instruction, expectedOutcome, maxActions });
      },
    }),

    new Tool({
      name: 'device_screen_verify',
      description: 'Capture the current screen of a paired device and use vision to verify a specific expected outcome. Returns a real interpretation or a real provider/device error; never assumes success.',
      inputSchema: {
        type: 'object',
        properties: { ...deviceIdProp, expectedOutcome: { type: 'string', maxLength: 2000 } },
        required: ['deviceId', 'expectedOutcome'],
      },
      requiredPermissions: ['screen.capture'],
      riskLevel: RiskLevel.LOW,
      status: visionInterpreter ? status : 'BLOCKED',
      execute: async ({ deviceId, expectedOutcome }) => {
        if (!visionInterpreter) return { success: false, error: 'No vision-capable provider is configured.' };
        const capture = await deviceManager.execute({ deviceId, capability: 'screen', action: 'capture', riskLevel: DeviceRiskLevel.LOW });
        if (!capture?.success || !capture?.result?.data?.base64) return { success: false, error: 'Screen capture failed.', captureResult: capture };
        const interpretation = await visionInterpreter.interpretScreenshot({
          base64: capture.result.data.base64, mimeType: capture.result.data.mimeType,
          question: `Verify whether this expected outcome is visibly true: ${expectedOutcome}. Return your normal structured screen interpretation and state uncertainty explicitly.`,
        });
        return { success: true, verified: Boolean(interpretation.parsed), expectedOutcome, interpretation };
      },
    }),

    new Tool({
      name: 'device_media_control',
      description: 'Control media playback (play, pause, stop, volume) on a connected device.',
      inputSchema: {
        type: 'object',
        properties: {
          ...deviceIdProp,
          action: { type: 'string', enum: ['play', 'pause', 'stop', 'volume_up', 'volume_down', 'mute'] },
        },
        required: ['deviceId', 'action'],
      },
      requiredPermissions: ['media.control'],
      riskLevel: RiskLevel.LOW,
      status,
      execute: async ({ deviceId, action }) =>
        deviceManager.execute({ deviceId, capability: 'media', action, riskLevel: DeviceRiskLevel.LOW }),
    }),
  ];
}
