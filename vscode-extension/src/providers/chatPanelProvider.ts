/**
 * Chat Panel Provider
 * 
 * Provides a WebView-based chat interface in the sidebar.
 */

import * as vscode from 'vscode';
import { ContextEngineClient } from '../client';
import { OutputChannelManager } from './outputChannelManager';

export class ChatPanelProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'contextEngine.chat';

  private _view?: vscode.WebviewView;
  private client: ContextEngineClient;
  private output: OutputChannelManager;
  private messages: { role: 'user' | 'assistant'; content: string }[] = [];

  constructor(
    private readonly extensionUri: vscode.Uri,
    client: ContextEngineClient,
    output: OutputChannelManager
  ) {
    this.client = client;
    this.output = output;
  }

  public resolveWebviewView(
    webviewView: vscode.WebviewView,
    context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken
  ) {
    this._view = webviewView;

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [this.extensionUri],
    };

    webviewView.webview.html = this.getHtmlForWebview(webviewView.webview);

    // Handle messages from the webview
    webviewView.webview.onDidReceiveMessage(async (data) => {
      switch (data.type) {
        case 'connect':
          await this.handleConnect();
          break;
        case 'disconnect':
          await this.handleDisconnect();
          break;
        case 'send':
          await this.handleMessage(data.message, data.action);
          break;
        case 'action':
          await this.handleAction(data.action);
          break;
        case 'getStatus':
          this.updateConnectionStatus();
          break;
      }
    });

    // Update status on view visible
    this.updateConnectionStatus();
  }

  /**
   * Handle connect button.
   */
  private async handleConnect(): Promise<void> {
    try {
      this.postMessage({ type: 'status', status: 'connecting' });
      await this.client.connect();
      this.updateConnectionStatus();
      this.addAssistantMessage('Connected to Context Engine server! 🎉');

      // Auto-index if stale or empty
      await this.checkAndAutoIndex();
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      this.postMessage({ type: 'status', status: 'error', message: msg });
      this.addAssistantMessage(`Failed to connect: ${msg}`);
    }
  }

  /**
   * Check if index is stale and auto-index if needed.
   */
  private async checkAndAutoIndex(): Promise<void> {
    try {
      const status = await this.client.getStatus();

      // Auto-index if no files indexed or if index is stale
      if (status.fileCount === 0 || status.isStale) {
        const reason = status.fileCount === 0 ? 'No files indexed' : 'Index is stale';
        this.addAssistantMessage(`${reason}. Auto-indexing workspace...`);

        const result = await this.client.indexWorkspace(false);
        this.addAssistantMessage(`✅ Indexed ${result.indexed} files in ${result.duration}ms`);
      } else {
        this.addAssistantMessage(`Index ready: ${status.fileCount} files indexed.`);
      }
    } catch (error) {
      // Silently ignore - not critical
      this.output.error('Auto-index check failed', error instanceof Error ? error : undefined);
    }
  }


  /**
   * Handle disconnect button.
   */
  private async handleDisconnect(): Promise<void> {
    this.client.disconnect();
    this.updateConnectionStatus();
    this.addAssistantMessage('Disconnected from server.');
  }

  /**
   * Handle user message.
   */
  private async handleMessage(message: string, action: string): Promise<void> {
    if (!message.trim()) return;

    // Add user message to chat
    this.messages.push({ role: 'user', content: message });
    this.postMessage({ type: 'addMessage', role: 'user', content: message });

    if (!this.client.isConnected()) {
      this.addAssistantMessage('Not connected to server. Click "Connect" to start.');
      return;
    }

    try {
      let response: string;

      switch (action) {
        case 'plan':
          this.postMessage({ type: 'thinking', action: 'Creating plan...' });
          const planResult = await this.client.createPlan(message);
          response = planResult.plan || JSON.stringify(planResult, null, 2);
          break;

        case 'enhance':
          this.postMessage({ type: 'thinking', action: 'Enhancing prompt... (requires AI API)' });
          try {
            const enhanceResult = await Promise.race([
              this.client.enhancePrompt(message),
              this.timeout(30000, 'Enhance prompt timed out. AI API may not be configured.')
            ]) as { enhanced: string };
            response = enhanceResult.enhanced;
          } catch (e) {
            response = `⚠️ Enhance prompt failed: ${e instanceof Error ? e.message : e}\n\nNote: This feature requires local-native AI provider configuration.`;
          }
          break;

        case 'search':
          this.postMessage({ type: 'thinking', action: 'Searching...' });
          const searchResult = await this.client.search(message, 10);
          if (searchResult.results.length === 0) {
            response = 'No results found. Try indexing the workspace first (click ⟳).';
          } else {
            response = searchResult.results
              .map((r, i) => `**${i + 1}. ${r.path}** (${Math.round((r.score ?? 0) * 100)}%)\n\`\`\`\n${r.content?.substring(0, 200) ?? ''}...\n\`\`\``)
              .join('\n\n');
          }
          break;

        case 'retrieval':
          this.postMessage({ type: 'thinking', action: 'Retrieving...' });
          const retrievalResult = await this.client.codebaseRetrieval(message, 10);
          if (retrievalResult.results && retrievalResult.results.length > 0) {
            response = retrievalResult.results
              .map((r, i) => `**${i + 1}. ${r.path}**\n\`\`\`\n${r.content?.substring(0, 200)}...\n\`\`\``)
              .join('\n\n');
          } else {
            response = 'No results found. Try indexing the workspace first.';
          }
          break;

        default:
          // Default to search (most reliable)
          this.postMessage({ type: 'thinking', action: 'Searching...' });
          const defaultResult = await this.client.search(message, 10);
          if (defaultResult.results.length === 0) {
            response = 'No results found.';
          } else {
            response = defaultResult.results
              .map((r, i) => `**${i + 1}. ${r.path}**\n${r.content?.substring(0, 150) ?? ''}...`)
              .join('\n\n');
          }
      }

      const normalizedResponse = typeof response === 'string'
        ? response
        : JSON.stringify(response ?? '', null, 2);
      this.addAssistantMessage(normalizedResponse || 'No response received.');
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      this.addAssistantMessage(`Error: ${msg}`);
      this.output.error('Chat error', error instanceof Error ? error : undefined);
    }
  }

  /**
   * Handle toolbar action.
   */
  private async handleAction(action: string): Promise<void> {
    switch (action) {
      case 'index':
        if (!this.client.isConnected()) {
          this.addAssistantMessage('Not connected. Please connect first.');
          return;
        }
        this.addAssistantMessage('Indexing workspace...');
        try {
          const result = await this.client.indexWorkspace(false);
          this.addAssistantMessage(`Indexed ${result.indexed} files in ${result.duration}ms`);
        } catch (error) {
          this.addAssistantMessage(`Indexing failed: ${error instanceof Error ? error.message : error}`);
        }
        break;

      case 'clear':
        this.messages = [];
        this.postMessage({ type: 'clearChat' });
        break;
    }
  }

  /**
   * Add assistant message.
   */
  private addAssistantMessage(content: string): void {
    this.messages.push({ role: 'assistant', content });
    this.postMessage({ type: 'addMessage', role: 'assistant', content });
  }

  /**
   * Create a timeout promise for race conditions.
   */
  private timeout(ms: number, message: string): Promise<never> {
    return new Promise((_, reject) => {
      setTimeout(() => reject(new Error(message)), ms);
    });
  }


  /**
   * Update connection status in webview.
   */
  private updateConnectionStatus(): void {
    const connected = this.client.isConnected();
    const version = this.client.getVersion();
    this.postMessage({
      type: 'status',
      status: connected ? 'connected' : 'disconnected',
      version,
    });
  }

  /**
   * Post message to webview.
   */
  private postMessage(message: unknown): void {
    this._view?.webview.postMessage(message);
  }

  /**
   * Get HTML content for the webview.
   */
  private getHtmlForWebview(webview: vscode.Webview): string {
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Context Engine</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    
    body {
      font-family: var(--vscode-font-family);
      font-size: var(--vscode-font-size);
      color: var(--vscode-foreground);
      background: var(--vscode-sideBar-background);
      height: 100vh;
      display: flex;
      flex-direction: column;
    }

    /* Header */
    .header {
      padding: 8px 12px;
      border-bottom: 1px solid var(--vscode-panel-border);
      display: flex;
      align-items: center;
      justify-content: space-between;
    }

    .status {
      display: flex;
      align-items: center;
      gap: 6px;
      font-size: 11px;
    }

    .status-dot {
      width: 8px;
      height: 8px;
      border-radius: 50%;
      background: var(--vscode-errorForeground);
    }

    .status-dot.connected {
      background: var(--vscode-testing-iconPassed);
    }

    .status-dot.connecting {
      background: var(--vscode-editorWarning-foreground);
      animation: pulse 1s infinite;
    }

    @keyframes pulse {
      0%, 100% { opacity: 1; }
      50% { opacity: 0.5; }
    }

    .connect-btn {
      padding: 4px 10px;
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
      border: none;
      border-radius: 3px;
      cursor: pointer;
      font-size: 11px;
    }

    .connect-btn:hover {
      background: var(--vscode-button-hoverBackground);
    }

    .connect-btn.disconnect {
      background: var(--vscode-errorForeground);
    }

    /* Messages */
    .messages {
      flex: 1;
      overflow-y: auto;
      padding: 12px;
      display: flex;
      flex-direction: column;
      gap: 12px;
    }

    .message {
      max-width: 95%;
      padding: 8px 12px;
      border-radius: 8px;
      font-size: 12px;
      line-height: 1.4;
      word-wrap: break-word;
    }

    .message.user {
      align-self: flex-end;
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
    }

    .message.assistant {
      align-self: flex-start;
      background: var(--vscode-editor-background);
      border: 1px solid var(--vscode-panel-border);
    }

    .message pre {
      background: var(--vscode-textCodeBlock-background);
      padding: 6px 8px;
      border-radius: 4px;
      overflow-x: auto;
      margin: 6px 0;
      font-size: 11px;
    }

    .thinking {
      font-style: italic;
      color: var(--vscode-descriptionForeground);
    }

    /* Toolbar */
    .toolbar {
      display: flex;
      gap: 4px;
      padding: 6px 12px;
      border-top: 1px solid var(--vscode-panel-border);
      background: var(--vscode-editor-background);
    }

    .tool-btn {
      padding: 6px 10px;
      background: transparent;
      color: var(--vscode-foreground);
      border: 1px solid var(--vscode-panel-border);
      border-radius: 4px;
      cursor: pointer;
      font-size: 11px;
      display: flex;
      align-items: center;
      gap: 4px;
    }

    .tool-btn:hover {
      background: var(--vscode-list-hoverBackground);
    }

    .tool-btn.active {
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
      border-color: var(--vscode-button-background);
    }

    /* Input */
    .input-area {
      padding: 8px 12px;
      border-top: 1px solid var(--vscode-panel-border);
      display: flex;
      gap: 8px;
    }

    .input-area textarea {
      flex: 1;
      padding: 8px;
      border: 1px solid var(--vscode-input-border);
      background: var(--vscode-input-background);
      color: var(--vscode-input-foreground);
      border-radius: 4px;
      resize: none;
      font-family: inherit;
      font-size: 12px;
      min-height: 36px;
      max-height: 100px;
    }

    .input-area textarea:focus {
      outline: 1px solid var(--vscode-focusBorder);
    }

    .send-btn {
      padding: 8px 16px;
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
      border: none;
      border-radius: 4px;
      cursor: pointer;
    }

    .send-btn:hover {
      background: var(--vscode-button-hoverBackground);
    }

    .send-btn:disabled {
      opacity: 0.5;
      cursor: not-allowed;
    }
  </style>
</head>
<body>
  <div class="header">
    <div class="status">
      <span class="status-dot" id="statusDot"></span>
      <span id="statusText">Disconnected</span>
    </div>
    <button class="connect-btn" id="connectBtn" onclick="toggleConnect()">Connect</button>
  </div>

  <div class="messages" id="messages">
    <div class="message assistant">
      👋 Welcome to Context Engine!<br><br>
      Click <strong>Connect</strong> to start, then use the toolbar buttons or type a message.
    </div>
  </div>

  <div class="toolbar">
    <button class="tool-btn" id="btnPlan" onclick="setAction('plan')" title="Create Plan">
      📋 Plan
    </button>
    <button class="tool-btn" id="btnEnhance" onclick="setAction('enhance')" title="Enhance Prompt">
      ✨ Enhance
    </button>
    <button class="tool-btn" id="btnSearch" onclick="setAction('search')" title="Semantic Search">
      🔍 Search
    </button>
    <button class="tool-btn" id="btnRetrieval" onclick="setAction('retrieval')" title="Codebase Retrieval">
      📚 Retrieve
    </button>
    <button class="tool-btn" onclick="doAction('index')" title="Index Workspace">
      ⟳
    </button>
    <button class="tool-btn" onclick="doAction('clear')" title="Clear Chat">
      🗑
    </button>
  </div>

  <div class="input-area">
    <textarea id="input" placeholder="Type your message..." rows="1" onkeydown="handleKeydown(event)"></textarea>
    <button class="send-btn" id="sendBtn" onclick="send()">Send</button>
  </div>

  <script>
    const vscode = acquireVsCodeApi();
    let connected = false;
    let currentAction = 'enhance';

    // Request initial status
    vscode.postMessage({ type: 'getStatus' });

    function toggleConnect() {
      vscode.postMessage({ type: connected ? 'disconnect' : 'connect' });
    }

    function setAction(action) {
      currentAction = action;
      document.querySelectorAll('.tool-btn').forEach(btn => btn.classList.remove('active'));
      document.getElementById('btn' + action.charAt(0).toUpperCase() + action.slice(1))?.classList.add('active');
    }

    function doAction(action) {
      vscode.postMessage({ type: 'action', action });
    }

    function send() {
      const input = document.getElementById('input');
      const message = input.value.trim();
      if (!message) return;
      
      vscode.postMessage({ type: 'send', message, action: currentAction });
      input.value = '';
      input.style.height = 'auto';
    }

    function handleKeydown(e) {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        send();
      }
    }

    function addMessage(role, content) {
      const messages = document.getElementById('messages');
      const msg = document.createElement('div');
      msg.className = 'message ' + role;
      
      // Simple markdown-like rendering
      let text = typeof content === 'string' ? content : JSON.stringify(content ?? '', null, 2);
      if (text === undefined) text = '';
      text = text
        .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
        .replace(/\`\`\`([\\s\\S]*?)\`\`\`/g, '<pre>$1</pre>')
        .replace(/\`([^\`]+)\`/g, '<code>$1</code>')
        .replace(/\\n/g, '<br>');
      
      msg.innerHTML = text;
      messages.appendChild(msg);
      messages.scrollTop = messages.scrollHeight;
    }

    // Handle messages from extension
    window.addEventListener('message', event => {
      const data = event.data;
      switch (data.type) {
        case 'status':
          connected = data.status === 'connected';
          const dot = document.getElementById('statusDot');
          const text = document.getElementById('statusText');
          const btn = document.getElementById('connectBtn');
          
          dot.className = 'status-dot ' + data.status;
          text.textContent = data.status === 'connected' 
            ? 'Connected' + (data.version ? ' v' + data.version : '')
            : data.status === 'connecting' ? 'Connecting...' : 'Disconnected';
          btn.textContent = connected ? 'Disconnect' : 'Connect';
          btn.className = 'connect-btn' + (connected ? ' disconnect' : '');
          break;

        case 'addMessage':
          const pending = document.querySelector('.thinking');
          if (pending) pending.remove();
          addMessage(data.role, data.content);
          break;

        case 'thinking':
          const thinking = document.querySelector('.thinking');
          if (thinking) thinking.remove();
          const messages = document.getElementById('messages');
          const t = document.createElement('div');
          t.className = 'message assistant thinking';
          t.textContent = data.action || 'Thinking...';
          messages.appendChild(t);
          messages.scrollTop = messages.scrollHeight;
          break;

        case 'clearChat':
          document.getElementById('messages').innerHTML = '';
          break;
      }
    });

    // Auto-resize textarea
    document.getElementById('input').addEventListener('input', function() {
      this.style.height = 'auto';
      this.style.height = Math.min(this.scrollHeight, 100) + 'px';
    });

    // Set default action to search (most reliable - works with local index)
    setAction('search');
  </script>
</body>
</html>`;
  }
}
