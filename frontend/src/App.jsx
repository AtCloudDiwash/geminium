import { useState, useRef, useEffect } from 'react';
import { Terminal } from 'xterm';
import 'xterm/css/xterm.css';

export default function App() {
  const [instanceId, setInstanceId] = useState('i-093cb858a51dfc168');
  const [connected, setConnected] = useState(false);
  const terminalRef = useRef(null);
  const terminal = useRef(null);
  const socketRef = useRef(null);

  const writeOutput = (message, color = 'white') => {
    if (!terminal.current) return;
    const timestamp = new Date().toLocaleTimeString();
    terminal.current.writeln(`\x1b[90m[${timestamp}]\x1b[0m \x1b[38;5;14m${message}\x1b[0m`);
  };

  // Initialize terminal once
  useEffect(() => {
    terminal.current = new Terminal({
      cursorBlink: true,
      fontSize: 14,
      fontFamily: 'Courier New, monospace',
      theme: {
        background: '#1e1e1e',
        foreground: '#d4d4d4',
        cursor: '#d4d4d4',
      },
    });

    terminal.current.open(terminalRef.current);
    terminal.current.writeln('Enter instance ID and click Connect...');
    terminal.current.write('> ');

    terminal.current.attachCustomKeyEventHandler((event) => {
      // Detect Ctrl+V (Windows/Linux) or Cmd+V (Mac)
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'v') {
        event.preventDefault(); // prevent default browser paste

        // Read from clipboard
        navigator.clipboard.readText().then((text) => {
          if (socketRef.current && socketRef.current.readyState === WebSocket.OPEN) {
            socketRef.current.send(JSON.stringify({
              type: 'input',
              data: text
            }));
          }
          // Show locally in terminal
          terminal.current.write(text);
        }).catch(err => console.error('Clipboard read failed', err));

        return false; // prevent further handling
      }

      return true; // allow other keys
    });


    let command = '';

    // Capture user keystrokes
    terminal.current.onKey(({ key, domEvent }) => {
      if (!socketRef.current || socketRef.current.readyState !== WebSocket.OPEN) return;

      // --- Ctrl+V / Cmd+V paste ---
      if ((domEvent.ctrlKey || domEvent.metaKey) && domEvent.key.toLowerCase() === 'v') {
        navigator.clipboard.readText().then((text) => {
          if (socketRef.current) {
            socketRef.current.send(JSON.stringify({ type: 'input', data: text }));
          }
        });
        return;
      }

      // --- Optional local 'clear' command ---
      if (key === '\r' && command.trim().toLowerCase() === 'clear') {
        terminal.current.clear();
        command = '';
        terminal.current.write('> '); // optional prompt
        return;
      }

      // --- Send every key immediately to backend ---
      socketRef.current.send(JSON.stringify({ type: 'input', data: key }));

      // --- Remove all local echo ---
      // Don't call terminal.current.write() for keys
      // Backend PTY will echo everything
    });



    return () => terminal.current.dispose();
  }, []);

  // Handle input change
  const handleChange = (e) => {
    setInstanceId(e.target.value);
  };

  // Connect to WebSocket server
  const handleConnect = () => {
    if (!instanceId) return;

    const wsUrl = `ws://localhost:3000?instanceId=${instanceId}`;
    socketRef.current = new WebSocket(wsUrl);

    socketRef.current.onopen = () => {
      setConnected(true);
      terminal.current.writeln(`Connected to WebSocket server with instanceId: ${instanceId}`);
    };

    socketRef.current.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);

        if (msg.type === 'connected') {
          writeOutput(msg.message, 'green');
        } else if (msg.type === 'output') {
          // Output raw terminal data including ANSI codes
          terminal.current.write(msg.data);
        }
      } catch (err) {
        console.error('Failed to parse WebSocket message:', err);
      }
    };

    socketRef.current.onclose = () => {
      setConnected(false);
      terminal.current.writeln('Disconnected from server.');
    };

    socketRef.current.onerror = (err) => {
      terminal.current.writeln(`WebSocket error: ${err.message}`);
    };
  };

  return (
    <div className="flex flex-col items-center justify-start min-h-screen bg-gray-900 p-6 gap-4">
      <h1 className="text-white text-2xl mb-2">React Terminal with WebSocket</h1>

      <div className="flex gap-2">
        <input
          type="text"
          placeholder="Enter instanceId"
          value={instanceId}
          onChange={handleChange}
          className="px-3 py-2 rounded-md border border-gray-700 bg-gray-800 text-white focus:outline-none focus:ring-2 focus:ring-blue-500"
        />
        <button
          onClick={handleConnect}
          className="px-4 py-2 bg-blue-600 rounded-md hover:bg-blue-700 text-white"
          disabled={connected}
        >
          {connected ? 'Connected' : 'Connect'}
        </button>
      </div>

      <div
        ref={terminalRef}
        className="w-full max-w-4xl h-96 border border-gray-700 rounded-md overflow-hidden"
      ></div>
    </div>
  );
}
