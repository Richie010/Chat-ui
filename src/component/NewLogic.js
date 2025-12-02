import React, { useEffect, useState, useRef } from 'react'
import { over } from 'stompjs';
import SockJS from 'sockjs-client';

var stompClient = null;
let currentUsernameForSubscribe = null;
let currentUserIdForFetch = null;

//const API_BASE = "https://vshareu-latest.onrender.com";
const API_BASE = "http://13.126.57.98:8080"; 

const INACTIVITY_TIMEOUT_MS = 30 * 1000; 
const SWEEP_INTERVAL_MS = 10 * 1000; 
const TYPING_DEBOUNCE_MS = 800; 

const ChatRoom = () => {
  const [privateChats, setPrivateChats] = useState(new Map());
  const [publicChats, setPublicChats] = useState([]);
  const [tab, setTab] = useState(null); 

  const [userData, setUserData] = useState({
    username: '',
    receivername: '',
    connected: false,
    message: ''
  });

  const [mobile, setMobile] = useState('');
  const [userId, setUserId] = useState(null);
  const [friends, setFriends] = useState([]);
  const [requests, setRequests] = useState([]);

  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState([]);

  const [activeUsers, setActiveUsers] = useState(new Set());
  const lastSeenRef = useRef({}); 
  const typingTimeoutsRef = useRef({}); 
  const [typingUsers, setTypingUsers] = useState(new Set()); 

  const myTypingTimeoutRef = useRef(null);

  const [showWelcome, setShowWelcome] = useState(false);

  const [isMobileChatOpen, setIsMobileChatOpen] = useState(false);

  const messagesContainerRef = useRef(null);

  useEffect(() => {
    const id = setInterval(() => {
      const now = Date.now();
      const lastSeen = lastSeenRef.current;
      let changed = false;
      const next = new Set(activeUsers);

      Object.entries(lastSeen).forEach(([name, ts]) => {
        if (now - ts > INACTIVITY_TIMEOUT_MS) {
          if (next.has(name)) {
            next.delete(name);
            changed = true;
          }
        }
      });

      if (changed) setActiveUsers(next);
    }, SWEEP_INTERVAL_MS);

    return () => clearInterval(id);
  }, [activeUsers]);

  const markActive = (username) => {
    if (!username) return;
    lastSeenRef.current[username] = Date.now();
    setActiveUsers(prev => {
      if (prev.has(username)) return prev;
      const next = new Set(prev);
      next.add(username);
      return next;
    });
  };

  const connect = (usernameArg, userIdArg) => {
    if (usernameArg) currentUsernameForSubscribe = usernameArg;
    else currentUsernameForSubscribe = userData.username;

    if (userIdArg) currentUserIdForFetch = userIdArg;
    else currentUserIdForFetch = userId;

    let Sock = new SockJS(`${API_BASE}/ws`);
    stompClient = over(Sock);
    stompClient.connect({}, onConnected, onError);
  }

  const onConnected = () => {
    setUserData(prev => ({ ...prev, connected: true }));

    stompClient.subscribe('/chatroom/public', onMessageReceived);

    const usernameToSubscribe = currentUsernameForSubscribe || userData.username;
    if (usernameToSubscribe) {
      stompClient.subscribe('/user/' + usernameToSubscribe + '/private', onPrivateMessage);
    } else {
      console.warn("onConnected: no username available for private subscribe");
    }

    const idToUse = currentUserIdForFetch || userId;
    fetchFriends(idToUse);
    fetchRequests(idToUse);

    userJoin();

    setShowWelcome(true);
    setTimeout(() => setShowWelcome(false), 2800);

    setTab(null);
  }

  const userJoin = () => {
    if (!stompClient) return;
    const chatMessage = {
      senderName: userData.username,
      status: "JOIN"
    };
    stompClient.send("/app/message", {}, JSON.stringify(chatMessage));
    markActive(userData.username);
  }

  const safeName = (raw) => {
    if (raw == null) return null;
    const s = String(raw).trim();
    return s.length ? s : null;
  }

  const onMessageReceived = (payload) => {
    const payloadData = JSON.parse(payload.body);
    const sender = safeName(payloadData.senderName);

    switch (payloadData.status) {
      case "JOIN":
        if (sender) {
          if (!privateChats.get(sender)) privateChats.set(sender, []);
          setPrivateChats(new Map(privateChats));
          markActive(sender);
        } else {
          console.warn("JOIN with empty senderName", payloadData);
        }
        break;

      case "MESSAGE":
        setPublicChats(prev => {
          const next = [...prev, payloadData];
          return next;
        });
        if (sender) markActive(sender);
        else console.warn("PUBLIC MESSAGE with empty senderName", payloadData);
        break;

      case "TYPING":
        if (sender) {
          handleRemoteTyping(sender, true);
          scheduleTypingStop(sender);
        }
        break;

      default:
        break;
    }
  }

  const onPrivateMessage = (payload) => {
    const payloadData = JSON.parse(payload.body);
    const sender = safeName(payloadData.senderName);

    if (!sender) {
      console.warn("private message with empty senderName", payloadData);
      return;
    }

    if (payloadData.status === "TYPING") {
      handleRemoteTyping(sender, true);
      scheduleTypingStop(sender);
      return;
    }

    setPrivateChats(prev => {
      const next = new Map(prev);
      if (next.get(sender)) {
        next.get(sender).push(payloadData);
      } else {
        next.set(sender, [payloadData]);
      }
      return next;
    });

    markActive(sender);
  }

  const onError = (err) => {
    console.log("STOMP error:", err);
  }

  const handleRemoteTyping = (username, isTyping) => {
    setTypingUsers(prev => {
      const next = new Set(prev);
      if (isTyping) next.add(username);
      else next.delete(username);
      return next;
    });
  };

  const scheduleTypingStop = (username) => {
    if (!username) return;
    if (typingTimeoutsRef.current[username]) {
      clearTimeout(typingTimeoutsRef.current[username]);
    }
    typingTimeoutsRef.current[username] = setTimeout(() => {
      handleRemoteTyping(username, false);
      delete typingTimeoutsRef.current[username];
    }, 1200);
  };

  const sendTypingEvent = (isPrivate = false, toUser = null) => {
    if (!stompClient) return;
    const msg = { senderName: userData.username, status: "TYPING" };
    if (isPrivate && toUser) msg.receiverName = toUser;

    try {
      if (isPrivate && toUser) {
        stompClient.send("/app/private-message", {}, JSON.stringify(msg));
      } else {
        stompClient.send("/app/message", {}, JSON.stringify(msg));
      }
    } catch (e) {
    }
  };

  const triggerMyTyping = (isPrivate = false, toUser = null) => {
    sendTypingEvent(isPrivate, toUser);

    if (myTypingTimeoutRef.current) clearTimeout(myTypingTimeoutRef.current);
    myTypingTimeoutRef.current = setTimeout(() => {
      myTypingTimeoutRef.current = null;
    }, TYPING_DEBOUNCE_MS);
  };

  const handleMessage = (event) => {
    setUserData({ ...userData, message: event.target.value });
    if (tab === "CHATROOM") triggerMyTyping(false, null);
    else triggerMyTyping(true, tab);
  }

  const sendValue = () => {
    if (!stompClient) return;
    const chatMessage = {
      senderName: userData.username,
      message: userData.message,
      status: "MESSAGE"
    };
    stompClient.send("/app/message", {}, JSON.stringify(chatMessage));
    setUserData({ ...userData, message: "" });
    markActive(userData.username);
  }

  const sendPrivateValue = () => {
    if (!stompClient) return;
    const receiver = safeName(tab);
    const chatMessage = {
      senderName: userData.username,
      receiverName: receiver,
      message: userData.message,
      status: "MESSAGE"
    };

    if (receiver && userData.username !== receiver) {
      setPrivateChats(prev => {
        const next = new Map(prev);
        if (!next.get(receiver)) next.set(receiver, []);
        next.get(receiver).push(chatMessage);
        return next;
      });
    }

    stompClient.send("/app/private-message", {}, JSON.stringify(chatMessage));
    setUserData({ ...userData, message: "" });
    markActive(userData.username);
    if (receiver) markActive(receiver);
  }

  const handleUsername = (event) => setUserData({ ...userData, username: event.target.value });
  const handleMobile = (e) => setMobile(e.target.value);

  const registerUser = async () => {
    if (!userData.username || !mobile) return alert("Enter name and mobile to register");
    try {
      const res = await fetch(`${API_BASE}/api/users`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: userData.username, mobile })
      });

      if (!res.ok) {
        const txt = await res.text();
        throw new Error(txt || "Register failed");
      }

      const user = await res.json();
      setUserId(user.id ?? null);
      const nameToUse = safeName(user.name) || safeName(user.username) || safeName(user.mobile) || userData.username;
      setUserData(prev => ({ ...prev, username: nameToUse }));
      currentUserIdForFetch = user.id ?? null;
      fetchFriends(user.id);
      fetchRequests(user.id);
      connect(nameToUse, user.id);
    } catch (e) {
      console.error("registerUser error", e);
      alert("Register error: " + (e.message || e));
    }
  }

  const loginUser = async () => {
    if (!mobile) return alert("Enter mobile to login");
    try {
      const res = await fetch(`${API_BASE}/api/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mobile })
      });

      if (!res.ok) {
        const fallback = await fetch(`${API_BASE}/api/users?query=${encodeURIComponent(mobile)}`);
        if (fallback.ok) {
          const list = await fallback.json();
          const found = (list || []).find(u => (u.mobile || "").replace(/\s+/g, "") === mobile.replace(/\s+/g, ""));
          if (!found) throw new Error("User not found in fallback search");
          setUserId(found.id ?? null);
          const nameToUse = safeName(found.name) || safeName(found.username) || safeName(found.mobile) || mobile;
          setUserData(prev => ({ ...prev, username: nameToUse }));
          currentUserIdForFetch = found.id ?? null;
          fetchFriends(found.id);
          fetchRequests(found.id);
          connect(nameToUse, found.id);
          return;
        } else {
          const txt = await res.text().catch(() => "Login failed");
          throw new Error(txt || "Login failed");
        }
      }

      const user = await res.json();
      setUserId(user.id ?? null);
      const nameToUse = safeName(user.name) || safeName(user.username) || safeName(user.mobile) || mobile;
      setUserData(prev => ({ ...prev, username: nameToUse }));
      currentUserIdForFetch = user.id ?? null;
      fetchFriends(user.id);
      fetchRequests(user.id);
      connect(nameToUse, user.id);
    } catch (e) {
      console.error("loginUser error", e);
      alert("Login error: " + (e.message || e));
    }
  }

  const fetchFriends = async (uid) => {
    if (!uid) return;
    try {
      const res = await fetch(`${API_BASE}/api/friends?userId=${uid}`);
      if (!res.ok) {
        setFriends([]);
        return;
      }
      const list = await res.json();
      setFriends(list || []);

      setPrivateChats(prev => {
        const next = new Map(prev);
        (list || []).forEach(f => {
          const raw = safeName(f.name) || safeName(f.username) || safeName(f.mobile) || (f.id != null ? String(f.id) : null);
          if (raw && !next.get(raw)) next.set(raw, []);
        });
        return next;
      });
    } catch (e) {
      console.error("fetchFriends error", e);
    }
  }

  const fetchRequests = async (uid) => {
    if (!uid) return;
    try {
      const res = await fetch(`${API_BASE}/api/friend-requests?receiverId=${uid}`);
      if (!res.ok) {
        setRequests([]);
        return;
      }
      const list = await res.json();
      setRequests(list || []);
    } catch (e) {
      console.error("fetchRequests error", e);
    }
  }

  const sendFriendRequest = async (receiverId) => {
    if (!userId) return alert("Login first");
    try {
      const res = await fetch(`${API_BASE}/api/friend-requests`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ requesterId: userId, receiverId })
      });
      if (!res.ok) {
        const txt = await res.text();
        throw new Error(txt || "Request failed");
      }
      alert("Friend request sent");
    } catch (e) {
      console.error("sendFriendRequest error", e);
      alert("Error: " + (e.message || e));
    }
  }

  const acceptRequest = async (reqOrId) => {
    let id = null;
    if (!reqOrId) return alert("Invalid request");
    if (typeof reqOrId === "object") id = reqOrId.id ?? reqOrId.requestId ?? reqOrId.request_id;
    else id = reqOrId;

    if (!id) return alert("Request id not found");
    try {
      const res = await fetch(`${API_BASE}/api/friend-requests/${encodeURIComponent(id)}/accept`, {
        method: "POST"
      });
      if (!res.ok) {
        const txt = await res.text();
        throw new Error(txt || "Accept failed");
      }
      await fetchFriends(userId);
      await fetchRequests(userId);
      alert("Accepted");
    } catch (e) {
      console.error("acceptRequest error", e);
      alert("Accept failed: " + (e.message || e));
    }
  }

  const searchUsers = async (q) => {
    setSearchQuery(q);
    if (!q || q.trim() === '') {
      setSearchResults([]);
      return;
    }

    try {
      const meIdParam = userId ? `&meId=${encodeURIComponent(userId)}` : '';
      const url = `${API_BASE}/api/users?query=${encodeURIComponent(q)}${meIdParam}`;
      const res = await fetch(url);
      if (!res.ok) {
        setSearchResults([]);
        return;
      }
      const list = await res.json();
      setSearchResults(list || []);
    } catch (e) {
      console.error("searchUsers error", e);
      setSearchResults([]);
    }
  }

  const openChatFromList = (name) => {
    const target = name === "CHATROOM" ? "CHATROOM" : name;
    setTab(target);
    if (window && window.innerWidth <= 720) {
      setIsMobileChatOpen(true);
    }
    setTimeout(() => scrollMessagesToBottom(), 80);
  };

  const closeMobileChat = () => {
    setIsMobileChatOpen(false);
  };

  const scrollMessagesToBottom = (immediate = true) => {
    const el = messagesContainerRef.current;
    if (!el) return;
    try {
      if (immediate) {
        el.scrollTop = el.scrollHeight;
      } else {
        el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
      }
    } catch (e) {
    }
  };

  const currentPrivateLength = tab && tab !== 'CHATROOM' ? (privateChats.get(tab) || []).length : 0;

  useEffect(() => {
    const el = messagesContainerRef.current;
    if (!el) return;

    let cancelled = false;
    let attempts = 0;

    const isInputFocused = (document && document.activeElement && ['INPUT', 'TEXTAREA'].includes(document.activeElement.tagName));

    const doScroll = () => {
      if (cancelled) return;
      attempts += 1;
      try {
        el.scrollTo({
          top: el.scrollHeight,
          behavior: isInputFocused ? 'auto' : 'smooth'
        });
      } catch (e) {
      }
      if (attempts < 6) {
        requestAnimationFrame(doScroll);
      }
    };

    const id = setTimeout(() => {
      requestAnimationFrame(doScroll);
    }, 30);

    return () => {
      cancelled = true;
      clearTimeout(id);
    };
  }, [publicChats.length, currentPrivateLength, tab]);

  const dedupeMessages = (arr) => {
  if (!Array.isArray(arr)) return [];
  const seen = new Set();
  const out = [];
  for (const m of arr) {
    const keyParts = [
      String(m.senderName ?? ''),
      '::',
      String(m.message ?? ''),
      '::',
      String(m.status ?? ''),
      '::',
      String(m.id ?? m.messageId ?? m.timestamp ?? m.sentAt ?? '')
    ];
    const key = keyParts.join('').slice(0, 800); 
    if (!seen.has(key)) {
      seen.add(key);
      out.push(m);
    }
  }
  return out;
};
  // ---------- UI ----------
  return (
    <div className="container">
      {showWelcome && (
        <div className="welcome-overlay" role="status" aria-live="polite">
          <div className="brand-anim">
            <div className="brand-text">vShareU</div>
            <div className="brand-sub">Fast • Secure • Mobile-first</div>
          </div>
        </div>
      )}

      {userData.connected ? (
        <div className={`chat-box ${isMobileChatOpen ? 'mobile-open' : ''}`}>
          <div className="member-list" aria-hidden={isMobileChatOpen ? 'true' : 'false'}>
            <div className="sidebar-brand">
              <div className={`logo ${showWelcome ? 'animate' : ''}`}>vS</div>
              <div>
                <div className="title">vShareU</div>
                <div className="subtitle">Fast • Secure • Mobile-first</div>
              </div>
            </div>

            <div className="sidebar-search">
              <input
                placeholder="Search users (mobile/name)"
                value={searchQuery}
                onChange={(e) => searchUsers(e.target.value)}
              />
            </div>

            {searchResults && searchResults.length > 0 && (
              <div className="search-results">
                {searchResults.map(sr => {
                  const display = sr.name || sr.mobile || `User ${sr.id}`;
                  return (
                    <div key={sr.id} style={{ display: 'flex', justifyContent: 'space-between', padding: 10, borderBottom: '1px solid #f0f3f5', alignItems: 'center' }}>
                      <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
                        <div style={{
                          width: 40, height: 40, borderRadius: 10, display: 'flex', alignItems: 'center', justifyContent: 'center',
                          background: 'linear-gradient(135deg,#06b6d4,#7c3aed)', color: '#fff', fontWeight: 700
                        }}>
                          {(sr.name || sr.mobile || 'U').toString().slice(0,2).toUpperCase()}
                        </div>
                        <div>
                          <div style={{ fontWeight: 700 }}>{display}</div>
                          <div style={{ fontSize: 12, color: '#666' }}>{sr.mobile}</div>
                        </div>
                      </div>
                      <div style={{ display: 'flex', gap: 8 }}>
                        <button onClick={() => sendFriendRequest(sr.id)}>Request</button>
                        
                      </div>
                    </div>
                  );
                })}
              </div>
            )}

            <div className="members-scroll" role="list">
              {/* Requests */}
              {requests && requests.length > 0 ? (
                <div style={{ padding: '6px 8px', width: '100%' }}>
                  <div style={{ fontWeight: 700, marginBottom: 6 }}>Requests</div>
                  {requests.map(r => (
                    <div key={r.id || r.requestId} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: 6 }}>
                      <div>
                        <div style={{ fontWeight: 600 }}>{r.fromName || r.fromMobile || r.requesterName}</div>
                        <div style={{ fontSize: 12, color: '#666' }}>{r.fromMobile}</div>
                      </div>
                      <div>
                        <button onClick={() => acceptRequest(r)}>Accept</button>
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                <div style={{ padding: '6px 8px', color: '#778' }}>No friend requests</div>
              )}

              {/* Global chat entry */}
              <div
                className={`member ${tab === "CHATROOM" ? 'active' : ''}`}
                onClick={() => openChatFromList("CHATROOM")}
                role="listitem"
              >
                <div className="avatar" style={{ background: 'linear-gradient(135deg,#06b6d4,#7c3aed)' }}>G</div>
                <div className="meta">
                  <div className="row" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <div className="name">Global Chat</div>
                    <div className="time"></div>
                  </div>
                  <div className="last">Public room</div>
                </div>
                <div className="badge" style={{ marginLeft: 8 }}>all</div>
              </div>

              {/* Contacts from privateChats */}
              {Array.from(privateChats.keys()).filter(Boolean).map((name) => {
                const online = activeUsers.has(name);
                const isTyping = typingUsers.has(name);
                return (
                  <div key={name} className={`member ${tab === name ? 'active' : ''}`} onClick={() => openChatFromList(name)} role="listitem">
                    <div style={{ position: 'relative' }}>
                      <div className="avatar">{(name || '').split(' ').map(n => n[0]).slice(0,2).join('').toUpperCase()}</div>
                      <div className={`presence ${online ? 'online' : 'offline'}`} style={{ position: 'absolute', right: -6 }} />
                    </div>

                    <div className="meta">
                      <div className="row">
                        <div className="name">{name}</div>
                        <div className="time"></div>
                      </div>
                      <div className="last">
                        {isTyping ? (<span className="typing" style={{ padding: '4px 8px' }}><span className="dot" /><span className="dot" /><span className="dot" /></span>) : <span style={{ color: '#7a8895' }}>Tap to chat</span>}
                      </div>
                    </div>
                  </div>
                );
              })}

              {/* Fallback: show friends list if privateChats empty */}
              {privateChats.size === 0 && friends.length > 0 && friends.map((f, i) => {
                const friendNameKey = safeName(f.name) || safeName(f.username) || safeName(f.mobile) || (f.id != null ? String(f.id) : null);
                if (!friendNameKey) return null;
                const online = activeUsers.has(friendNameKey);
                const isTyping = typingUsers.has(friendNameKey);
                return (
                  <div key={'fb-' + i} className={`member ${tab === friendNameKey ? 'active' : ''}`} onClick={() => openChatFromList(friendNameKey)} role="listitem">
                    <div style={{ position: 'relative' }}>
                      <div className="avatar">{friendNameKey.split(' ').map(n => n[0]).slice(0,2).join('').toUpperCase()}</div>
                      <div className={`presence ${online ? 'online' : 'offline'}`} style={{ position: 'absolute', right: -6 }} />
                    </div>

                    <div className="meta">
                      <div className="row">
                        <div className="name">{friendNameKey}</div>
                        <div className="time"></div>
                      </div>
                      <div className="last">
                        {isTyping ? (<span className="typing" style={{ padding: '4px 8px' }}><span className="dot" /><span className="dot" /><span className="dot" /></span>) : <span style={{ color: '#7a8895' }}>Tap to chat</span>}
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>

          {/* Chat area */}
          <div className="chat-content">
            <div className="chat-top">
              <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
                {(isMobileChatOpen && window && window.innerWidth <= 720) && (
                  <button aria-label="Back to list" onClick={closeMobileChat} className="back-button">
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden focusable="false">
                      <path d="M15 18l-6-6 6-6" stroke="#0b1116" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"></path>
                    </svg>
                  </button>
                )}
                <div className="mini-avatar">{tab === 'CHATROOM' ? 'G' : (tab || 'U').slice(0,2).toUpperCase()}</div>
                <div>
                  <h3 style={{ margin: 0 }}>{tab === 'CHATROOM' ? 'Global Chat' : (tab || 'Select a friend')}</h3>
                  <p style={{ margin: 0 }}>{tab === 'CHATROOM' ? 'Share with everyone' : (tab ? 'Private conversation' : 'Tap a friend to start') }</p>
                </div>
              </div>
            </div>

            {/* Messages area: when tab is null show placeholder */}
            <div className="chat-messages" id="chat-messages" ref={messagesContainerRef}>
              { !tab ? (
                <div style={{ padding: 18, color: '#64748b' }}>
                  <div style={{ fontWeight: 700, marginBottom: 6 }}>Welcome</div>
                  <div>Choose a friend from the list above to open the chat. Your recent friends are shown — tap one to start messaging.</div>
                </div>
              ) : (tab === "CHATROOM" ? (
               dedupeMessages(publicChats.map((chat, idx) => (
                  <div key={idx} className="msg-row" style={{ justifyContent: chat.senderName === userData.username ? 'flex-end' : 'flex-start' }}>
                    <div className={`message ${chat.senderName === userData.username ? 'self' : ''}`}>
                      <div style={{ fontWeight: 700, marginBottom: 6 }}>{chat.senderName || 'Unknown'}</div>
                      <div>{chat.message}</div>
                      <span className="meta-line"></span>
                    </div>
                  </div>
                )))
              ) : (
                dedupeMessages(privateChats.get(tab) || []).map((chat, idx) => (
                  <div key={idx} className={`msg-row ${chat.senderName === userData.username ? 'align-end' : ''}`}>
                    <div className={`message ${chat.senderName === userData.username ? 'self' : ''}`}>
                      <div style={{ fontWeight: 700, marginBottom: 6 }}>{chat.senderName}</div>
                      <div>{chat.message}</div>
                      <span className="meta-line"></span>
                    </div>
                  </div>
                ))
              ))}

              {/* show typing indicator for the current contact */}
              {tab && tab !== "CHATROOM" && typingUsers.has(tab) && (
                <div style={{ display: 'flex', marginTop: 6 }}>
                  <div className="typing"><div className="dot"></div><div className="dot"></div><div className="dot"></div></div>
                </div>
              )}
            </div>

            {/* composer: only enable when a chat is open */}
            <div className="send-wrapper">
              <div className="send-message" style={{ width: '100%' }}>
                <input
                  type="text"
                  className="input-message"
                  placeholder={ tab ? "enter the message" : "select a friend to start messaging" }
                  value={userData.message}
                  onChange={handleMessage}
                  disabled={!tab}
                />
                <button
                  className="send-button"
                  onClick={tab === "CHATROOM" ? sendValue : sendPrivateValue}
                  disabled={!tab || !userData.message}
                >
                  send
                </button>
              </div>
            </div>
          </div>
        </div>
      ) : (
        <div className="register" style={{ padding: 20 }}>
          <input id="user-name" placeholder="Enter your name" value={userData.username} onChange={handleUsername} style={{ display: 'block', marginBottom: 8, padding: 8, width: '100%' }} />
          <input id="mobile" placeholder="Enter your mobile" value={mobile} onChange={handleMobile} style={{ display: 'block', marginBottom: 8, padding: 8, width: '100%' }} />
          <div style={{ display: 'flex', gap: 8 }}>
            <button type="button" onClick={registerUser}>Register & Connect</button>
            <button type="button" onClick={loginUser}>Login & Connect</button>
          </div>
        </div>
      )}
    </div>
  );
}

export default ChatRoom;
