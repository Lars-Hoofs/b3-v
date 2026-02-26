/**
 * Widget Loader Script Generator
 * 
 * Generates a thin client-side JavaScript that:
 * 1. Fetches rendered HTML from the API
 * 2. Injects it into the DOM
 * 3. Loads Socket.IO + Remixicon CDN
 * 4. Handles chat open/close
 * 5. Handles messaging (send/receive via Socket.IO + REST)
 * 
 * This is a SIMPLE script — no HTML generation, just behavior.
 */

export function generateWidgetLoader(): string {
  return `(function() {
  'use strict';

  var config = window.aiChatConfig;
  if (!config || !config.installCode) {
    console.error('Bonsai Widget: Missing configuration. Set window.aiChatConfig = { installCode: "...", apiUrl: "..." }');
    return;
  }

  var apiUrl = config.apiUrl || window.location.origin;
  var installCode = config.installCode;
  var socket = null;
  var conversationId = null;
  var chatInitialized = false;

  // ─── 1. Load Dependencies ──────────────────────────────────────────

  function loadCSS(href, id) {
    if (document.getElementById(id)) return;
    var link = document.createElement('link');
    link.id = id;
    link.rel = 'stylesheet';
    link.href = href;
    link.crossOrigin = 'anonymous';
    document.head.appendChild(link);
  }

  function loadScript(src, callback) {
    var script = document.createElement('script');
    script.src = src;
    script.onload = callback;
    script.onerror = function() { console.error('Bonsai Widget: Failed to load ' + src); };
    document.head.appendChild(script);
  }

  // Load Remixicon for icons
  loadCSS('https://cdn.jsdelivr.net/npm/remixicon@4.7.0/fonts/remixicon.css', 'remixicon-css');

  // ─── 2. Fetch and Inject Widget HTML ───────────────────────────────

  fetch(apiUrl + '/api/widgets/render/' + installCode)
    .then(function(res) {
      if (!res.ok) throw new Error('HTTP ' + res.status);
      return res.text();
    })
    .then(function(html) {
      // Inject the rendered HTML into the page
      var wrapper = document.createElement('div');
      wrapper.innerHTML = html;
      while (wrapper.firstChild) {
        document.body.appendChild(wrapper.firstChild);
      }

      // Now set up all behavior
      setupWidget();
    })
    .catch(function(err) {
      console.error('Bonsai Widget: Failed to load widget', err);
    });

  // ─── 3. Widget Behavior Setup ──────────────────────────────────────

  function setupWidget() {
    var bubble = document.getElementById('ai-chat-bubble');
    var chatWindow = document.getElementById('ai-chat-window');
    var closeBtn = document.getElementById('ai-chat-close');
    var sendBtn = document.getElementById('ai-chat-send');
    var input = document.getElementById('ai-chat-input');

    if (!bubble || !chatWindow) {
      console.error('Bonsai Widget: Required elements not found');
      return;
    }

    // Toggle chat on bubble click
    bubble.addEventListener('click', function() {
      chatWindow.style.display = 'flex';
      bubble.style.display = 'none';
      if (!chatInitialized) {
        initializeChat();
      }
    });

    // Close chat
    if (closeBtn) {
      closeBtn.addEventListener('click', function(e) {
        e.stopPropagation();
        chatWindow.style.display = 'none';
        bubble.style.display = 'flex';
      });
    }

    // Launcher block click handlers (data-click-action)
    var clickables = document.querySelectorAll('[data-click-action]');
    for (var i = 0; i < clickables.length; i++) {
      (function(el) {
        var action = el.getAttribute('data-click-action');
        el.addEventListener('click', function(e) {
          e.stopPropagation();
          if (action === 'toggle-chat' || action === 'open-chat') {
            chatWindow.style.display = 'flex';
            bubble.style.display = 'none';
            if (!chatInitialized) initializeChat();
          } else if (action === 'open-url') {
            var url = el.getAttribute('data-click-url');
            if (url) window.open(url, '_blank');
          }
        });
      })(clickables[i]);
    }

    // Chat block click handlers (data-chat-action)
    var chatClickables = document.querySelectorAll('[data-chat-action]');
    for (var j = 0; j < chatClickables.length; j++) {
      (function(el) {
        var action = el.getAttribute('data-chat-action');
        el.addEventListener('click', function(e) {
          e.stopPropagation();
          if (action === 'close-chat') {
            chatWindow.style.display = 'none';
            bubble.style.display = 'flex';
          } else if (action === 'open-url') {
            var url = el.getAttribute('data-chat-url');
            if (url) window.open(url, '_blank');
          }
        });
      })(chatClickables[j]);
    }

    // Send message handlers
    if (sendBtn) {
      sendBtn.addEventListener('click', sendMessage);
    }
    if (input) {
      input.addEventListener('keypress', function(e) {
        if (e.key === 'Enter') sendMessage();
      });
    }

    // Auto-open support — read from data attribute set by renderer
    var container = document.getElementById('ai-chat-widget-container');
    if (container && container.getAttribute('data-auto-open') === 'true') {
      var delay = parseInt(container.getAttribute('data-auto-open-delay') || '5000', 10);
      setTimeout(function() {
        chatWindow.style.display = 'flex';
        bubble.style.display = 'none';
        if (!chatInitialized) initializeChat();
      }, delay);
    }
  }

  // ─── 4. Chat Initialization ────────────────────────────────────────

  function initializeChat() {
    chatInitialized = true;

    // Load Socket.IO then connect
    if (typeof io !== 'undefined') {
      connectSocket();
    } else {
      loadScript('https://cdn.socket.io/4.6.1/socket.io.min.js', connectSocket);
    }
  }

  function connectSocket() {
    if (socket) return;

    try {
      socket = io(apiUrl);
    } catch (e) {
      console.error('Bonsai Widget: Socket.IO connection failed', e);
      return;
    }

    // Keep track of streaming message elements
    var streamElements = {};

    socket.on('ai:thinking', function() {
      var typing = document.getElementById('ai-chat-typing');
      if (typing) typing.style.display = 'block';
    });

    socket.on('ai:stream:start', function(data) {
      var typing = document.getElementById('ai-chat-typing');
      if (typing) typing.style.display = 'none';
      
      // Create empty message container
      var msgDiv = appendMessage('', false);
      msgDiv.id = 'msg-' + data.id;
      streamElements[data.id] = msgDiv;
    });

    socket.on('ai:stream:chunk', function(data) {
      var msgDiv = streamElements[data.id];
      if (msgDiv) {
        // Simple append for now, replace newlines
        // In a real app we'd run markdown parsing here
        var textNode = document.createTextNode(data.content);
        if (data.content.includes('\\n')) {
          var parts = data.content.split('\\n');
          for (var i = 0; i < parts.length; i++) {
            msgDiv.appendChild(document.createTextNode(parts[i]));
            if (i < parts.length - 1) msgDiv.appendChild(document.createElement('br'));
          }
        } else {
          msgDiv.appendChild(textNode);
        }
        
        var messages = document.getElementById('ai-chat-messages');
        if (messages) messages.scrollTop = messages.scrollHeight;
      }
    });

    socket.on('ai:stream:end', function(data) {
      // Cleanup reference
      delete streamElements[data.id];
    });

    socket.on('ai:response', function(data) {
      var typing = document.getElementById('ai-chat-typing');
      if (typing) typing.style.display = 'none';
      
      // Only append if it wasn't streamed (fallback)
      if (!document.getElementById('msg-' + data.id)) {
        var msgDiv = appendMessage(data.content, false, data.metadata && data.metadata.sources);
        msgDiv.id = 'msg-' + data.id;
      } else {
        // If it was streamed, we might want to append sources now
        var msgDiv = document.getElementById('msg-' + data.id);
        if (msgDiv && data.metadata && data.metadata.sources && data.metadata.sources.length > 0) {
          appendSources(msgDiv, data.metadata.sources);
        }
      }
    });

    socket.on('message:new', function(data) {
      if (data.role && data.role.toLowerCase() === 'user') return;
      // Also check if we already have this message from streaming
      if (data.id && document.getElementById('msg-' + data.id)) return;
      
      var msgDiv = appendMessage(data.content, false);
      if (data.id) msgDiv.id = 'msg-' + data.id;
    });

    // Create conversation
    createConversation();
  }

  function createConversation() {
    // First get widget config to find widgetId
    fetch(apiUrl + '/api/widgets/config/' + installCode)
      .then(function(res) { return res.json(); })
      .then(function(widgetData) {
        var widgetId = widgetData.id || installCode;

        return fetch(apiUrl + '/api/chat/conversations/start', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            widgetId: widgetId,
            visitorMetadata: {
              userAgent: navigator.userAgent,
              language: navigator.language,
              referrer: document.referrer,
              currentUrl: window.location.href
            }
          })
        });
      })
      .then(function(res) { return res.json(); })
      .then(function(data) {
        conversationId = data.id;
        if (socket) socket.emit('join:conversation', { conversationId: conversationId });

        // Show greeting from config
        var container = document.getElementById('ai-chat-widget-container');
        var greeting = container ? container.getAttribute('data-greeting') : null;
        if (greeting) {
          appendMessage(greeting, false);
        }

        // Show suggested questions
        var suggestedRaw = container ? container.getAttribute('data-suggested') : null;
        if (suggestedRaw) {
          try {
            var questions = JSON.parse(suggestedRaw);
            if (questions && questions.length > 0) showSuggestedQuestions(questions);
          } catch (e) {}
        }
      })
      .catch(function(err) {
        console.error('Bonsai Widget: Failed to create conversation', err);
        var messages = document.getElementById('ai-chat-messages');
        if (messages) {
          messages.innerHTML = '<div style="padding: 20px; text-align: center; color: #ef4444;">Failed to connect. Please refresh the page.</div>';
        }
      });
  }

  // ─── 5. Messaging ──────────────────────────────────────────────────

  function sendMessage() {
    var input = document.getElementById('ai-chat-input');
    if (!input) return;

    var message = input.value.trim();
    if (!message || !conversationId) return;

    appendMessage(message, true);
    input.value = '';

    // Send via Socket.IO
    if (socket) {
      socket.emit('message:send', {
        conversationId: conversationId,
        content: message
      });
    }

    // Also via REST for persistence
    fetch(apiUrl + '/api/chat/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        conversationId: conversationId,
        content: message,
        role: 'USER',
        currentPageUrl: window.location.href
      })
    }).catch(function() {});
  }

  function appendMessage(content, isUser, sources) {
    var messages = document.getElementById('ai-chat-messages');
    if (!messages) return;

    // Read styling from data attributes on container
    var container = document.getElementById('ai-chat-widget-container');
    var userMsgColor = (container && container.getAttribute('data-user-msg-color')) || '#000000';
    var userMsgTextColor = (container && container.getAttribute('data-user-msg-text-color')) || '#ffffff';
    var botMsgColor = (container && container.getAttribute('data-bot-msg-color')) || '#f3f4f6';
    var botMsgTextColor = (container && container.getAttribute('data-bot-msg-text-color')) || '#111827';
    var msgRadius = (container && container.getAttribute('data-msg-radius')) || '18';

    var div = document.createElement('div');
    div.style.cssText = [
      'max-width: 85%',
      'padding: 14px 18px',
      'border-radius: ' + msgRadius + 'px',
      'background: ' + (isUser ? userMsgColor : botMsgColor),
      'color: ' + (isUser ? userMsgTextColor : botMsgTextColor),
      'align-self: ' + (isUser ? 'flex-end' : 'flex-start'),
      'font-size: 15px',
      'line-height: 1.6',
      'word-wrap: break-word',
      'animation: slideIn 0.3s cubic-bezier(0.2, 0.8, 0.2, 1)',
    ].join('; ');

    div.innerHTML = content ? content.replace(/\\n/g, '<br>') : '';

    if (!isUser && sources && sources.length > 0) {
      appendSources(div, sources);
    }

    messages.appendChild(div);
    messages.scrollTop = messages.scrollHeight;
    
    return div; // Return the element so we can modify it later (e.g. streaming)
  }

  function appendSources(div, sources) {
      var sourcesDiv = document.createElement('div');
      sourcesDiv.style.cssText = 'margin-top: 12px; padding-top: 10px; border-top: 1px solid rgba(0,0,0,0.05); display: flex; gap: 8px; flex-wrap: wrap;';

      var hasValid = false;
      sources.forEach(function(s) {
        var url = s.url || s.sourceUrl;
        if (!url) return;
        try {
          hasValid = true;
          var domain = new URL(url).hostname;
          var link = document.createElement('a');
          link.href = url;
          link.target = '_blank';
          link.title = s.title || domain;
          link.style.cssText = 'display: block; text-decoration: none; border-radius: 50%; transition: transform 0.2s;';
          var img = document.createElement('img');
          img.src = 'https://www.google.com/s2/favicons?domain=' + domain + '&sz=64';
          img.style.cssText = 'width: 24px; height: 24px; border-radius: 50%; border: 1px solid rgba(0,0,0,0.1); background: white; object-fit: cover;';
          link.appendChild(img);
          sourcesDiv.appendChild(link);
        } catch (e) {}
      });

      if (hasValid) div.appendChild(sourcesDiv);
  }

  function showSuggestedQuestions(questions) {
    var messages = document.getElementById('ai-chat-messages');
    if (!messages) return;

    var container = document.createElement('div');
    container.style.cssText = 'display: flex; flex-wrap: wrap; gap: 8px; margin-top: 8px;';

    var primaryColor = document.getElementById('ai-chat-widget-container');
    var pColor = (primaryColor && primaryColor.getAttribute('data-primary-color')) || '#000000';

    questions.forEach(function(q) {
      var btn = document.createElement('button');
      btn.textContent = q;
      btn.style.cssText = 'padding: 8px 12px; background: white; border: 1px solid ' + pColor + '; color: ' + pColor + '; border-radius: 16px; font-size: 13px; cursor: pointer; transition: all 0.2s;';
      btn.addEventListener('click', function() {
        var input = document.getElementById('ai-chat-input');
        if (input) {
          input.value = q;
          sendMessage();
        }
      });
      container.appendChild(btn);
    });

    messages.appendChild(container);
  }

})();`;
}
