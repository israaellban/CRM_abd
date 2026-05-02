import React, { useState, useEffect, useRef } from "react";
import { MessageSquare, Send, Search, Settings, Shield, LogOut, Loader2, Phone, KeyRound, MoreVertical, RefreshCw, Mic, X, Download, CornerUpLeft, Play, Pause } from "lucide-react";
import { motion, AnimatePresence } from "motion/react";

interface Chat {
  id: string;
  chat_id: string;
  chat_name: string;
  chat_type: string;
  last_message_at: string;
  unread_count: number;
}

interface Message {
  id: string;
  text: string;
  type: string;
  media_url?: string;
  media_name?: string;
  reply_to_platform_id?: string;
  platform_message_id: string;
  sent_at: string;
  is_outgoing: boolean;
  participants?: {
    display_name: string;
  };
}

export default function App() {
  const [isUnlocked, setIsUnlocked] = useState(false);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [authStatus, setAuthStatus] = useState({ isConnected: false, isAuthorized: false });
  const [phone, setPhone] = useState("");
  const [code, setCode] = useState("");
  const [loginStep, setLoginStep] = useState(0); // 0: phone, 1: code
  const [chats, setChats] = useState<Chat[]>([]);
  const [selectedChat, setSelectedChat] = useState<Chat | null>(null);
  const [messages, setMessages] = useState<Message[]>([]);
  const [newMessage, setNewMessage] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [isSending, setIsSending] = useState(false);
  const [replyingTo, setReplyingTo] = useState<Message | null>(null);
  const [isRecording, setIsRecording] = useState(false);
  const [recordDuration, setRecordDuration] = useState(0);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const audioChunksRef = useRef<Blob[]>([]);
  const recordIntervalRef = useRef<number | null>(null);

  const messagesEndRef = useRef<HTMLDivElement>(null);
  const scrollAreaRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [shouldAutoScroll, setShouldAutoScroll] = useState(true);

  useEffect(() => {
    checkAuthStatus();
  }, []);

  const handleScroll = () => {
    if (!scrollAreaRef.current) return;
    const { scrollTop, scrollHeight, clientHeight } = scrollAreaRef.current;
    // If we're within 100px of bottom, enable auto-scroll
    const isAtBottom = scrollHeight - scrollTop - clientHeight < 100;
    setShouldAutoScroll(isAtBottom);
  };

  useEffect(() => {
    if (shouldAutoScroll) {
      scrollToBottom();
    }
  }, [messages]);

  const scrollToBottom = (force = false) => {
    if (force || shouldAutoScroll) {
      messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
    }
  };

  const checkAuthStatus = async () => {
    try {
      const res = await fetch("/api/auth-status");
      const data = await res.json();
      setAuthStatus(data);
    } catch (e) {
      console.error("Auth status check failed", e);
    }
  };

  const handleLoginSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsLoading(true);
    try {
      const res = await fetch("/api/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password }),
      });
      if (res.ok) setIsUnlocked(true);
      else alert("Invalid credentials");
    } catch (e) {
      alert("Login failed");
    } finally {
      setIsLoading(false);
    }
  };

  const handleFullLogout = async () => {
    // Direct logout for better reliability in framing environments
    setIsLoading(true);
    try {
      console.log("Triggering full logout...");
      const res = await fetch("/api/logout-full", { method: "POST" });
      if (res.ok) {
        // Clear all local auth states
        setAuthStatus({ isConnected: false, isAuthorized: false });
        setPhone("");
        setLoginStep(0);
        setIsUnlocked(false);
        setPassword("");
        setEmail("");
        setMessages([]);
        setSelectedChat(null);
        // Success alert
        alert("Session reset successful. The page will reload.");
        setTimeout(() => {
          window.location.reload();
        }, 1500);
      } else {
        const err = await res.json();
        alert("Reset failed: " + (err.error || "Server error"));
      }
    } catch (e) {
      console.error("Reset fetch error:", e);
      alert("Failed to connect to server for reset.");
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    if (isUnlocked && authStatus.isAuthorized) {
      fetchChats();
      const interval = setInterval(fetchChats, 10000);
      return () => clearInterval(interval);
    }
  }, [isUnlocked, authStatus.isAuthorized]);

  useEffect(() => {
    if (selectedChat) {
      setMessages([]); // Clear messages when switching chats
      setShouldAutoScroll(true); // Auto scroll to bottom of new chat
      fetchMessages(selectedChat.chat_id);
      markAsRead(selectedChat.chat_id);
      const interval = setInterval(() => fetchMessages(selectedChat.chat_id), 3000);
      return () => clearInterval(interval);
    }
  }, [selectedChat]);

  const markAsRead = async (chatId: string) => {
    try {
      await fetch("/api/mark-as-read", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id: chatId }),
      });
      setChats(prev => prev.map(c => c.chat_id === chatId ? { ...c, unread_count: 0 } : c));
    } catch (e) {
      console.error("Failed to mark as read", e);
    }
  };

  const handleRequestCode = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsLoading(true);
    await fetch("/api/telegram/request-code", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ phone }),
    });
    setLoginStep(1);
    setIsLoading(false);
  };

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsLoading(true);
    const res = await fetch("/api/telegram/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code }),
    });
    if (res.ok) {
      await checkAuthStatus();
    } else {
      alert("Login failed");
    }
    setIsLoading(false);
  };

  const fetchChats = async () => {
    const res = await fetch("/api/conversations");
    const data = await res.json();
    setChats(data);
  };

  const fetchMessages = async (chatId: string) => {
    try {
      const res = await fetch(`/api/messages?chat_id=${chatId}`);
      if (!res.ok) throw new Error("Failed to fetch messages");
      const data = await res.json();
      setMessages(data);
    } catch (e) {
      console.error("Fetch messages error:", e);
    }
  };

  const handleSendMessage = async (e: React.FormEvent) => {
    e.preventDefault();
    if ((!newMessage.trim() && !file) || !selectedChat) return;

    setIsSending(true);
    try {
      const formData = new FormData();
      formData.append("chat_id", selectedChat.chat_id);
      formData.append("text", newMessage);
      if (file) {
        formData.append("file", file);
      }
      if (replyingTo) {
        formData.append("reply_to_msg_id", replyingTo.platform_message_id);
      }

      const res = await fetch("/api/send", {
        method: "POST",
        body: formData,
      });

      if (res.ok) {
        setNewMessage("");
        setFile(null);
        setReplyingTo(null);
        if (fileInputRef.current) fileInputRef.current.value = "";
        await fetchMessages(selectedChat.chat_id);
        setShouldAutoScroll(true); // Force scroll on my own message
        setTimeout(() => scrollToBottom(true), 100);
      }
    } catch (e) {
      console.error("Failed to send", e);
    } finally {
      setIsSending(false);
    }
  };

  const startRecording = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const recorder = new MediaRecorder(stream);
      mediaRecorderRef.current = recorder;
      audioChunksRef.current = [];

      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) audioChunksRef.current.push(e.data);
      };

      recorder.onstop = async () => {
        const audioBlob = new Blob(audioChunksRef.current, { type: "audio/ogg" });
        if (audioBlob.size > 0) {
          sendVoiceMessage(audioBlob);
        }
        stream.getTracks().forEach(track => track.stop());
      };

      recorder.start();
      setIsRecording(true);
      setRecordDuration(0);
      recordIntervalRef.current = window.setInterval(() => {
        setRecordDuration(prev => prev + 1);
      }, 1000);
    } catch (e) {
      alert("Microphone access denied or error");
      console.error(e);
    }
  };

  const stopRecording = () => {
    if (mediaRecorderRef.current && isRecording) {
      mediaRecorderRef.current.stop();
      setIsRecording(false);
      if (recordIntervalRef.current) clearInterval(recordIntervalRef.current);
    }
  };

  const sendVoiceMessage = async (blob: Blob) => {
    if (!selectedChat) return;
    setIsSending(true);
    try {
      const formData = new FormData();
      formData.append("chat_id", selectedChat.chat_id);
      formData.append("file", blob, "voice.ogg");
      formData.append("type", "voice");
      if (replyingTo) {
        formData.append("reply_to_msg_id", replyingTo.platform_message_id);
      }

      const res = await fetch("/api/send", {
        method: "POST",
        body: formData,
      });

      if (res.ok) {
        setReplyingTo(null);
        await fetchMessages(selectedChat.chat_id);
      }
    } catch (e) {
      console.error("Failed to send voice", e);
    } finally {
      setIsSending(false);
    }
  };

  const formatDuration = (sec: number) => {
    const m = Math.floor(sec / 60);
    const s = sec % 60;
    return `${m}:${s < 10 ? '0' : ''}${s}`;
  };

  const onFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files[0]) {
      setFile(e.target.files[0]);
    }
  };

  if (!isUnlocked) {
    return (
      <div className="min-h-screen bg-[#F3F4F6] flex flex-col items-center justify-center p-4 font-sans">
        <motion.div 
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          className="w-full max-w-md bg-white border border-gray-200 rounded-3xl p-8 shadow-xl"
        >
          <div className="w-16 h-16 bg-indigo-600 rounded-2xl flex items-center justify-center mx-auto mb-6 shadow-lg shadow-indigo-200">
            <Shield className="text-white w-8 h-8" />
          </div>
          <h1 className="text-2xl font-bold text-gray-900 text-center mb-2 tracking-tight">Access Control</h1>
          <p className="text-gray-500 text-center mb-8 text-sm">Please verify your credentials to enter</p>
          <form onSubmit={handleLoginSubmit} className="space-y-4">
            <input
              type="email"
              placeholder="Email"
              className="w-full bg-gray-50 border border-gray-200 rounded-xl px-4 py-3 focus:outline-none focus:ring-2 focus:ring-indigo-500"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
            />
            <input
              type="password"
              placeholder="Dashboard Password"
              className="w-full bg-gray-50 border border-gray-200 text-gray-900 rounded-xl px-4 py-3 focus:outline-none focus:ring-2 focus:ring-indigo-500 transition-all font-mono"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoFocus
            />
            <button 
              disabled={isLoading}
              className="w-full bg-indigo-600 hover:bg-indigo-700 disabled:opacity-50 text-white font-semibold py-3.5 rounded-xl transition-all shadow-md active:scale-[0.98] flex items-center justify-center"
            >
              {isLoading ? <Loader2 className="animate-spin" size={20} /> : "Verify & Enter"}
            </button>
          </form>
        </motion.div>
      </div>
    );
  }

  if (!authStatus.isAuthorized) {
    return (
      <div className="min-h-screen bg-[#F3F4F6] flex flex-col items-center justify-center p-4">
        <motion.div 
          initial={{ opacity: 0, scale: 0.95 }}
          animate={{ opacity: 1, scale: 1 }}
          className="w-full max-w-md bg-white border border-gray-200 rounded-3xl p-8 shadow-xl"
        >
          <div className="flex justify-center mb-6">
            <div className="p-4 bg-indigo-50 rounded-2xl border border-indigo-100">
              <MessageSquare className="text-indigo-600 w-10 h-10" />
            </div>
          </div>
          <h1 className="text-2xl font-bold text-gray-900 text-center mb-2 tracking-tight transition-all">TeleBridge Setup</h1>
          <p className="text-gray-500 text-center mb-8 text-sm">
            Sync your Telegram messages using Telethon
          </p>

          <AnimatePresence mode="wait">
            {loginStep === 0 ? (
              <motion.form
                key="step-phone"
                initial={{ opacity: 0, x: -20 }}
                animate={{ opacity: 1, x: 0 }}
                exit={{ opacity: 0, x: 20 }}
                onSubmit={handleRequestCode}
                className="space-y-4"
              >
                <div className="relative">
                  <Phone className="absolute left-4 top-1/2 -translate-y-1/2 text-gray-400 w-5 h-5" />
                  <input
                    type="tel"
                    placeholder="Phone Number (ex: +12345...)"
                    className="w-full bg-gray-50 border border-gray-200 text-gray-900 rounded-xl pl-12 pr-4 py-3.5 focus:outline-none focus:ring-2 focus:ring-indigo-500"
                    value={phone}
                    onChange={(e) => setPhone(e.target.value)}
                    required
                  />
                </div>
                <button 
                  disabled={isLoading}
                  className="w-full bg-indigo-600 hover:bg-indigo-700 disabled:opacity-50 text-white font-semibold py-3.5 rounded-xl flex items-center justify-center gap-2 shadow-md"
                >
                  {isLoading ? <Loader2 className="animate-spin w-5 h-5" /> : "Request Verification Code"}
                </button>
              </motion.form>
            ) : (
              <motion.form
                key="step-code"
                initial={{ opacity: 0, x: 20 }}
                animate={{ opacity: 1, x: 0 }}
                exit={{ opacity: 0, x: -20 }}
                onSubmit={handleLogin}
                className="space-y-4"
              >
                <div className="relative">
                  <KeyRound className="absolute left-4 top-1/2 -translate-y-1/2 text-gray-400 w-5 h-5" />
                  <input
                    type="text"
                    placeholder="Enter Code"
                    className="w-full bg-gray-50 border border-gray-200 text-gray-900 rounded-xl pl-12 pr-4 py-3.5 focus:outline-none focus:ring-2 focus:ring-indigo-500"
                    value={code}
                    onChange={(e) => setCode(e.target.value)}
                    required
                  />
                </div>
                <button 
                  disabled={isLoading}
                  className="w-full bg-indigo-600 hover:bg-indigo-700 disabled:opacity-50 text-white font-semibold py-3.5 rounded-xl flex items-center justify-center gap-2 shadow-md"
                >
                  {isLoading ? <Loader2 className="animate-spin w-5 h-5" /> : "Verify & Sign In"}
                </button>
                <button 
                  type="button"
                  onClick={() => setLoginStep(0)}
                  className="w-full text-indigo-600 hover:text-indigo-700 text-xs font-semibold uppercase tracking-wider transition-colors"
                >
                  Back to Phone Number
                </button>
                <div className="pt-4 border-t border-gray-100 flex justify-center">
                  <button 
                    type="button"
                    onClick={handleFullLogout}
                    className="text-red-500 hover:text-red-600 text-[10px] font-bold uppercase tracking-widest transition-colors flex items-center gap-1.5"
                  >
                    <RefreshCw size={12} />
                    Reset & Start Over
                  </button>
                </div>
              </motion.form>
            )}
          </AnimatePresence>
          
          {loginStep === 0 && (
            <div className="mt-8 pt-4 border-t border-gray-100 flex justify-center">
              <button 
                type="button"
                onClick={handleFullLogout}
                className="text-gray-400 hover:text-red-500 text-[10px] font-bold uppercase tracking-widest transition-colors flex items-center gap-1.5"
              >
                <RefreshCw size={12} />
                Reset Current Session
              </button>
            </div>
          )}
        </motion.div>
      </div>
    );
  }

  return (
    <div className="h-screen bg-[#F3F4F6] flex text-gray-900 overflow-hidden font-sans">
      {/* Sidebar */}
      <div className="w-80 bg-white border-r border-gray-200 flex flex-col">
        <div className="p-4 border-b border-gray-100 flex justify-between items-center bg-white">
          <h1 className="text-xl font-bold tracking-tight text-indigo-600">TeleBridge</h1>
          <div className="h-2 w-2 rounded-full bg-green-500 shadow-[0_0_8px_rgba(34,197,94,0.6)]"></div>
        </div>
        
        <div className="px-4 py-3">
          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" size={14} />
            <input 
              type="text" 
              placeholder="Search messages..."
              className="w-full bg-gray-100 border-none rounded-lg py-2 pl-9 pr-4 text-xs focus:ring-2 focus:ring-indigo-500 outline-none transition-all"
            />
          </div>
        </div>

        <div className="flex-1 overflow-y-auto mt-2 space-y-0.5">
          {chats.map((chat) => (
            <button
              key={chat.id}
              onClick={() => setSelectedChat(chat)}
              className={`w-full flex items-center px-4 py-3 transition-colors cursor-pointer group ${
                selectedChat?.chat_id === chat.chat_id 
                  ? "bg-indigo-50 border-l-4 border-indigo-600" 
                  : "hover:bg-gray-50 border-l-4 border-transparent"
              }`}
            >
              <div className={`h-12 w-12 rounded-full flex-shrink-0 flex items-center justify-center font-bold shadow-sm transition-colors ${
                selectedChat?.chat_id === chat.chat_id ? "bg-indigo-200 text-indigo-700" : "bg-gray-100 text-gray-500"
              }`}>
                {chat.chat_name[0].toUpperCase()}
              </div>
              <div className="ml-3 flex-1 overflow-hidden text-left">
                <div className="flex justify-between items-baseline">
                  <h3 className={`text-sm font-semibold truncate ${selectedChat?.chat_id === chat.chat_id ? "text-gray-900" : "text-gray-700"}`}>
                    {chat.chat_name}
                  </h3>
                  <span className="text-[10px] text-gray-500">
                    {new Date(chat.last_message_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                  </span>
                </div>
                <div className="flex items-center justify-between mt-0.5">
                  <p className={`text-xs truncate max-w-[120px] ${selectedChat?.chat_id === chat.chat_id ? "text-indigo-600 font-medium" : "text-gray-500"}`}>
                    Last sync updated...
                  </p>
                  {chat.unread_count > 0 && (
                    <div className="bg-indigo-600 text-white text-[10px] px-1.5 py-0.5 rounded-full font-bold">
                      {chat.unread_count}
                    </div>
                  )}
                </div>
              </div>
            </button>
          ))}
        </div>

        <div className="p-4 border-t border-gray-100 mt-auto space-y-3">
          <div className="flex items-center justify-between">
            <button 
              onClick={() => setIsUnlocked(false)}
              className="flex items-center gap-2 text-gray-400 hover:text-indigo-600 transition-colors"
              title="Lock dashboard"
            >
              <Shield size={16} />
              <span className="text-[11px] font-bold uppercase tracking-wider">Lock</span>
            </button>
            <button 
              onClick={handleFullLogout}
              className="flex items-center gap-2 text-gray-400 hover:text-red-600 transition-colors"
              title="Delete session and logout"
            >
              <LogOut size={16} />
              <span className="text-[11px] font-bold uppercase tracking-wider">Reset</span>
            </button>
          </div>
          <div className="flex items-center justify-between pt-2 border-t border-gray-50">
            <span className="text-[8px] text-gray-300 font-mono">TeleBridge v1.2</span>
            <Settings size={14} className="text-gray-300 hover:text-indigo-600 cursor-pointer" />
          </div>
        </div>
      </div>

      {/* Main Chat Area */}
      <div className="flex-1 flex flex-col bg-[#F9FAFB] relative font-sans">
        {selectedChat ? (
          <>
            {/* Chat Header */}
            <header className="h-16 bg-white border-b border-gray-200 flex items-center justify-between px-6 z-10 shadow-sm transition-all">
              <div className="flex items-center">
                <div className="h-10 w-10 rounded-full bg-indigo-200 flex items-center justify-center font-semibold text-indigo-700 border border-indigo-100">
                  {selectedChat.chat_name[0].toUpperCase()}
                </div>
                <div className="ml-3">
                  <h2 className="text-sm font-bold text-gray-900">{selectedChat.chat_name}</h2>
                  <p className="text-[10px] text-green-500 font-bold uppercase tracking-wider flex items-center gap-1.5">
                    <span className="h-1.5 w-1.5 rounded-full bg-green-500 ring-2 ring-green-100" />
                    Online
                  </p>
                </div>
              </div>
              <div className="flex items-center gap-5 text-gray-400">
                <button 
                  onClick={() => fetchMessages(selectedChat.chat_id)}
                  className="p-2 hover:bg-gray-100 rounded-full transition-colors group"
                  title="Refresh messages"
                >
                  <RefreshCw size={18} className="group-hover:text-indigo-600" />
                </button>
                <MoreVertical size={18} className="cursor-pointer hover:text-indigo-600 transition-colors" />
              </div>
            </header>

            {/* Messages Area */}
            <div 
              ref={scrollAreaRef}
              onScroll={handleScroll}
              className="flex-1 overflow-y-auto p-6 space-y-4"
            >
              <div className="flex flex-col items-center mb-6">
                <span className="text-[10px] font-bold text-gray-400 bg-white px-3 py-1 rounded-full shadow-sm border border-gray-100 tracking-widest">TODAY</span>
              </div>

              {messages.map((msg, i) => {
                const isFirstOfGroup = i === 0 || messages[i-1].is_outgoing !== msg.is_outgoing;
                return (
                  <div 
                    key={msg.id} 
                    className={`flex items-end gap-2 ${msg.is_outgoing ? "justify-end" : "justify-start"}`}
                  >
                    {!msg.is_outgoing && (
                      <div className="h-8 w-8 rounded-full bg-indigo-100 flex-shrink-0 flex items-center justify-center text-[10px] font-bold text-indigo-600 border border-indigo-50 shadow-sm">
                        {(msg.participants?.display_name || "U")[0].toUpperCase()}
                      </div>
                    )}
                    
                    <motion.div
                      initial={{ opacity: 0, y: 5 }}
                      animate={{ opacity: 1, y: 0 }}
                      className={`max-w-md p-1 relative shadow-sm ${
                        msg.is_outgoing 
                          ? "bg-indigo-600 text-white rounded-2xl rounded-br-none shadow-indigo-100" 
                          : "bg-white text-gray-800 rounded-2xl rounded-bl-none border border-gray-100"
                      }`}
                    >
                      <div className="p-2.5">
                        {msg.reply_to_platform_id && (
                          <div className={`mb-2 p-2 rounded-lg border-l-4 text-[11px] truncate ${
                            msg.is_outgoing ? "bg-indigo-700/50 border-indigo-400 text-indigo-100" : "bg-gray-50 border-indigo-300 text-gray-500"
                          }`}>
                            {(() => {
                              const replied = messages.find(m => m.platform_message_id === msg.reply_to_platform_id);
                              return replied ? (
                                <>
                                  <p className="font-bold opacity-70 mb-0.5">{replied.is_outgoing ? "You" : (replied.participants?.display_name || "User")}</p>
                                  <p className="truncate italic">"{replied.text || (replied.type === 'image' ? 'Image' : 'File')}"</p>
                                </>
                              ) : "Replied to a message";
                            })()}
                          </div>
                        )}
                        {msg.type === "image" && (
                          <div className="mb-2 rounded-lg overflow-hidden border border-gray-100/20">
                            {msg.media_url ? (
                              <img src={msg.media_url} alt="Media" className="max-w-full h-auto cursor-pointer hover:opacity-90 transition-opacity" referrerPolicy="no-referrer" />
                            ) : (
                              <div className="p-4 bg-gray-100 text-gray-400 text-xs flex items-center gap-2">
                                <span>Image from Telegram</span>
                              </div>
                            )}
                          </div>
                        )}
                        {msg.type === "voice" && (
                          <div className={`mb-2 p-2 rounded-xl flex items-center gap-3 ${
                            msg.is_outgoing ? "bg-indigo-700/50" : "bg-gray-50 border border-gray-100"
                          }`}>
                            <div className={`p-2 rounded-full ${msg.is_outgoing ? "bg-indigo-500" : "bg-indigo-100"}`}>
                              <Mic className={`${msg.is_outgoing ? "text-indigo-100" : "text-indigo-600"}`} size={16} />
                            </div>
                            <audio src={msg.media_url} controls className="h-8 max-w-[180px] filter saturate-0 brightness-150" />
                          </div>
                        )}
                        {msg.type === "file" && (
                          <div className={`mb-2 p-3 rounded-xl flex items-center gap-3 border ${
                            msg.is_outgoing ? "bg-indigo-700/50 border-indigo-500" : "bg-gray-50 border-gray-100"
                          }`}>
                            <div className={`p-2 rounded-lg ${msg.is_outgoing ? "bg-indigo-500" : "bg-indigo-100"}`}>
                              <Download className={`${msg.is_outgoing ? "text-indigo-100" : "text-indigo-600"}`} size={16} />
                            </div>
                            <div className="flex-1 overflow-hidden">
                              <p className="text-[11px] font-bold truncate">{msg.media_name || "Attachment"}</p>
                              {msg.media_url && (
                                <a 
                                  href={`/api/download?url=${encodeURIComponent(msg.media_url)}&filename=${encodeURIComponent(msg.media_name || "file")}`}
                                  target="_blank" 
                                  rel="noopener noreferrer" 
                                  className={`text-[9px] font-bold uppercase transition-opacity hover:opacity-100 ${msg.is_outgoing ? "text-indigo-200 opacity-70" : "text-indigo-600 opacity-80"}`}
                                >
                                  Download File
                                </a>
                              )}
                            </div>
                          </div>
                        )}
                        <p className="text-sm leading-relaxed whitespace-pre-wrap">{msg.text}</p>
                        <div className="flex items-center justify-between mt-1 gap-4">
                           <button 
                            onClick={() => setReplyingTo(msg)}
                            className={`p-1 rounded hover:bg-black/10 transition-colors ${msg.is_outgoing ? "text-indigo-300" : "text-gray-300 hover:text-indigo-500"}`}
                           >
                             <CornerUpLeft size={12} />
                           </button>
                           <p className={`text-[9px] font-medium ${
                            msg.is_outgoing ? "text-indigo-200" : "text-gray-400"
                          }`}>
                            {new Date(msg.sent_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                          </p>
                        </div>
                      </div>
                    </motion.div>
                  </div>
                );
              })}
              <div ref={messagesEndRef} />
            </div>

            {/* Input Bar */}
            <div className="p-4 bg-white border-t border-gray-200">
              <AnimatePresence>
                {replyingTo && (
                  <motion.div 
                    initial={{ opacity: 0, height: 0 }}
                    animate={{ opacity: 1, height: "auto" }}
                    exit={{ opacity: 0, height: 0 }}
                    className="mb-2 p-2 bg-gray-100 border-l-4 border-indigo-500 rounded-lg flex items-center justify-between"
                  >
                    <div className="flex-1 overflow-hidden">
                      <p className="text-[10px] font-bold text-indigo-600 uppercase mb-0.5">Replying to {replyingTo.is_outgoing ? "yourself" : (replyingTo.participants?.display_name || "User")}</p>
                      <p className="text-xs text-gray-500 truncate italic">"{replyingTo.text || (replyingTo.type === 'image' ? 'Image' : 'File')}"</p>
                    </div>
                    <button 
                      onClick={() => setReplyingTo(null)}
                      className="p-1 hover:bg-gray-200 rounded-full text-gray-400 transition-colors"
                    >
                      <X size={14} />
                    </button>
                  </motion.div>
                )}
                {file && (
                  <motion.div 
                    initial={{ opacity: 0, y: 10 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, y: 10 }}
                    className="mb-3 p-2 bg-indigo-50 border border-indigo-100 rounded-xl flex items-center justify-between"
                  >
                    <div className="flex items-center gap-2 overflow-hidden px-2">
                      <div className="p-1.5 bg-indigo-200 rounded-lg text-indigo-700">
                        <Download size={12} />
                      </div>
                      <span className="text-xs font-semibold text-indigo-700 truncate">{file.name}</span>
                    </div>
                    <button 
                      onClick={() => setFile(null)}
                      className="p-1.5 hover:bg-indigo-200 rounded-lg text-indigo-400 hover:text-indigo-700 transition-colors"
                    >
                      <X size={14} />
                    </button>
                  </motion.div>
                )}
              </AnimatePresence>

              <form onSubmit={handleSendMessage} className="flex items-center space-x-3">
                <input 
                  type="file"
                  ref={fileInputRef}
                  onChange={onFileSelect}
                  className="hidden"
                />
                
                {isRecording ? (
                  <div className="flex-1 flex items-center gap-3 bg-red-50 border border-red-100 rounded-full px-4 py-2">
                    <span className="flex h-2 w-2 rounded-full bg-red-500 animate-pulse"></span>
                    <span className="text-xs font-bold text-red-600 font-mono flex-1">{formatDuration(recordDuration)}</span>
                    <button 
                      type="button"
                      onClick={stopRecording}
                      className="text-red-500 hover:text-red-700 font-bold text-[10px] uppercase tracking-wider"
                    >
                      Stop & Send
                    </button>
                    <button 
                      type="button"
                      onClick={() => { setIsRecording(false); if (recordIntervalRef.current) clearInterval(recordIntervalRef.current); }}
                      className="text-gray-400 hover:text-gray-600"
                    >
                      <X size={16} />
                    </button>
                  </div>
                ) : (
                  <>
                    <button 
                      type="button"
                      onClick={() => fileInputRef.current?.click()}
                      className="text-gray-400 hover:text-indigo-600 transition-colors p-2 rounded-full hover:bg-gray-50"
                    >
                      <svg className="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M12 6v6m0 0v6m0-6h6m-6 0H6"/></svg>
                    </button>
                    
                    <div className="flex-1 relative">
                      <input 
                        type="text" 
                        autoFocus
                        placeholder={file ? "Add a caption..." : replyingTo ? "Type your reply..." : "Write a message..."}
                        className="w-full border border-gray-200 rounded-full py-2.5 px-6 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent bg-gray-50/50 shadow-inner"
                        value={newMessage}
                        onChange={(e) => setNewMessage(e.target.value)}
                      />
                    </div>

                    <button 
                      type="button"
                      onClick={startRecording}
                      className="p-2.5 text-gray-400 hover:text-indigo-600 hover:bg-indigo-50 rounded-full transition-all active:scale-95"
                      title="Hold to record"
                    >
                      <Mic size={20} />
                    </button>

                    <button 
                      disabled={isSending || (!newMessage.trim() && !file)}
                      className="bg-indigo-600 text-white p-2.5 rounded-full hover:bg-indigo-700 transition-all shadow-lg active:scale-95 disabled:opacity-50 disabled:grayscale"
                    >
                      {isSending ? <Loader2 size={20} className="animate-spin" /> : <Send size={20} />}
                    </button>
                  </>
                )}
              </form>
            </div>
          </>
        ) : (
          <div className="flex-1 flex flex-col items-center justify-center p-8 bg-gray-50/50">
            <div className="w-20 h-20 bg-white shadow-xl rounded-[2.5rem] flex items-center justify-center mb-8 border border-gray-100">
              <MessageSquare className="text-indigo-200" size={36} />
            </div>
            <h2 className="text-xl font-bold text-gray-900 mb-2 tracking-tight transition-all">Sync Ready</h2>
            <p className="text-gray-400 max-w-[240px] text-center text-sm leading-relaxed transition-all">
              Select a chat to begin bridge synchronization and view encrypted message history.
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
