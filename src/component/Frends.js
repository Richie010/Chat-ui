// ChatRoom.jsx
import React, { useEffect, useState, useRef } from "react";
import { over } from "stompjs";
import SockJS from "sockjs-client";

let stompClient = null;
const API_BASE = "http://localhost:8081"; // change if backend runs elsewhere

const ChatRoom = () => {
  // chat state
  const [privateChats, setPrivateChats] = useState(new Map());
  const [publicChats, setPublicChats] = useState([]);
  const [tab, setTab] = useState("CHATROOM");

  // user state
  const [userData, setUserData] = useState({
    username: "",
    connected: false,
    message: ""
  });
  const [mobile, setMobile] = useState("");
  const [userId, setUserId] = useState(null);

  // social state
  const [friends, setFriends] = useState([]); // [{id, mobile, name}]
  const [requests, setRequests] = useState([]); // incoming friend requests
  const [searchQuery, setSearchQuery] = useState("");
  const [searchResults, setSearchResults] = useState([]);

  // ui refs
  const publicScrollRef = useRef(null);
  const privateScrollRef = useRef(null);

  useEffect(() => {
    if (publicScrollRef.current) {
      publicScrollRef.current.scrollTop = publicScrollRef.current.scrollHeight;
    }
  }, [publicChats]);

  useEffect(() => {
    if (privateScrollRef.current) {
      privateScrollRef.current.scrollTop = privateScrollRef.current.scrollHeight;
    }
  }, [privateChats, tab]);

  // ---------------- WebSocket ----------------
  const connectWithMobile = (userMobile) => {
    const Sock = new SockJS(`${API_BASE}/ws`);
    stompClient = over(Sock);

    // pass mobile header; server ChannelInterceptor should map to Principal
    stompClient.connect({ mobile: userMobile }, () => onConnected(userMobile), onError);
  };

  const onConnected = (userMobile) => {
    setUserData((prev) => ({ ...prev, connected: true }));
    // public + private subscriptions
    stompClient.subscribe("/chatroom/public", onMessageReceived);
    stompClient.subscribe("/user/" + userMobile + "/private", onPrivateMessage);
    userJoin();
  };

  const userJoin = () => {
    if (!stompClient) return;
    const chatMessage = { senderName: userData.username, status: "JOIN" };
    stompClient.send("/app/message", {}, JSON.stringify(chatMessage));
  };

  const onMessageReceived = (payload) => {
    try {
      const data = JSON.parse(payload.body);
      switch (data.status) {
        case "JOIN":
          if (!privateChats.get(data.senderName)) {
            const copy = new Map(privateChats);
            copy.set(data.senderName, []);
            setPrivateChats(copy);
          }
          break;
        case "MESSAGE":
          setPublicChats((prev) => [...prev, data]);
          break;
        default:
          break;
      }
    } catch (e) {
      console.error("onMessageReceived parse error", e);
    }
  };

  const onPrivateMessage = (payload) => {
    try {
      const data = JSON.parse(payload.body);

      // social control messages
      if (data.type === "FRIEND_REQUEST") {
        setRequests((prev) => [data, ...prev]);
        return;
      }
      if (data.type === "FRIEND_ACCEPT") {
        const friendMobile = data.friendMobile || data.fromMobile || data.senderMobile;
        const friendName = data.friendName || data.fromName || friendMobile;
        const friendId = data.friendId || null;

        setFriends((prev) => {
          if (prev.find((f) => f.mobile === friendMobile)) return prev;
          return [{ id: friendId, mobile: friendMobile, name: friendName }, ...prev];
        });

        setPrivateChats((prev) => {
          const m = new Map(prev);
          if (!m.has(friendMobile)) m.set(friendMobile, []);
          return m;
        });
        return;
      }

      // normal private chat message
      const sender = data.senderName || data.senderMobile || data.fromMobile;
      if (!sender) return;

      setPrivateChats((prev) => {
        const m = new Map(prev);
        if (m.has(sender)) {
          m.get(sender).push(data);
        } else {
          m.set(sender, [data]);
        }
        return new Map(m);
      });
    } catch (e) {
      console.error("onPrivateMessage parse error", e);
    }
  };

  const onError = (err) => {
    console.error("STOMP error", err);
    // Optionally notify UI
  };

  // --------------- REST + UI handlers ---------------
  const handleUsername = (e) => setUserData((p) => ({ ...p, username: e.target.value }));
  const handleMobile = (e) => setMobile(e.target.value);

  // LOGIN by mobile — calls /api/login (200 => user) else fallback to search
  const loginUser = async () => {
    if (!mobile) return alert("Enter your mobile to login");

    try {
      const res = await fetch(`${API_BASE}/api/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mobile })
      });

      let user = null;

      if (res.status === 200) {
        user = await res.json();
      } else if (res.status === 404) {
        // fallback: query users
        const searchRes = await fetch(`${API_BASE}/api/users?query=${encodeURIComponent(mobile)}`);
        if (searchRes.ok) {
          const list = await searchRes.json();
          user = (list || []).find((u) => (u.mobile || "").replace(/\s+/g, "") === mobile.replace(/\s+/g, ""));
        }
      } else {
        const txt = await res.text().catch(() => "Login failed");
        throw new Error(txt || `Login returned status ${res.status}`);
      }

      if (!user) {
        return alert("User not found. Please register first (use Register button).");
      }

      // success: set user and connect websocket
      setUserId(user.id);
      setUserData((prev) => ({ ...prev, username: user.name || "", connected: false }));

      // connect to STOMP (server must map 'mobile' header to Principal)
      connectWithMobile(user.mobile);

      // fetch friends + incoming requests immediately
      await fetchFriends(user.id);
      await fetchIncomingRequests(user.id);
    } catch (e) {
      console.error("loginUser error", e);
      alert("Login failed: " + (e.message || e));
    }
  };

  // REGISTER (create user) — requires name + mobile
  const registerUser = async () => {
    if (!mobile || !userData.username) {
      return alert("Enter both mobile and name to register");
    }
    try {
      const res = await fetch(`${API_BASE}/api/users`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ mobile, name: userData.username })
      });
      if (!res.ok) {
        const txt = await res.text();
        throw new Error(txt || "Registration failed");
      }
      const user = await res.json();
      setUserId(user.id);
      setUserData((prev) => ({ ...prev, username: user.name || prev.username }));
      // connect & fetch friends/requests
      connectWithMobile(user.mobile);
      await fetchFriends(user.id);
      await fetchIncomingRequests(user.id);
    } catch (e) {
      console.error("registerUser error", e);
      alert("Register error: " + (e.message || e));
    }
  };

  const fetchFriends = async (id) => {
    if (!id) return;
    try {
      const res = await fetch(`${API_BASE}/api/friends?userId=${id}`);
      if (!res.ok) throw new Error("Failed to fetch friends");
      const list = await res.json();
      setFriends(list || []);
      // initialize privateChats keys for friends
      setPrivateChats((prev) => {
        const m = new Map(prev);
        (list || []).forEach((f) => m.set(f.mobile, m.get(f.mobile) || []));
        return m;
      });
    } catch (e) {
      console.error("fetchFriends", e);
    }
  };

  const fetchIncomingRequests = async (id) => {
    if (!id) return;
    try {
      const res = await fetch(`${API_BASE}/api/friend-requests?receiverId=${id}`);
      if (!res.ok) throw new Error("Failed to fetch requests");
      const list = await res.json();
      console.debug("Incoming requests:", list);
      setRequests(list || []);
    } catch (e) {
      console.error("fetchIncomingRequests", e);
    }
  };

  const searchUsers = async (q) => {
    setSearchQuery(q);
    if (!q) {
      setSearchResults([]);
      return;
    }
    try {
      const meIdParam = userId ? `&meId=${userId}` : "";
      const res = await fetch(`${API_BASE}/api/users?query=${encodeURIComponent(q)}${meIdParam}`);
      if (!res.ok) throw new Error("Search failed");
      const list = await res.json();
      setSearchResults(list || []);
    } catch (e) {
      console.error("searchUsers", e);
      setSearchResults([]);
    }
  };

  const sendFriendRequest = async (receiverId) => {
    if (!userId) return alert("You must be logged in");
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
      alert("Request sent");
    } catch (e) {
      console.error("sendFriendRequest", e);
      alert("Send failed: " + (e.message || e));
    }
  };

  // ----------- ROBUST ACCEPT FUNCTION --------------
  const acceptRequest = async (requestOrId) => {
    try {
      // Extract the id safely
      let id = null;

      if (requestOrId == null) {
        console.error("acceptRequest called with null:", requestOrId);
        return alert("Internal error: request missing");
      }

      if (typeof requestOrId === "number" || typeof requestOrId === "string") {
        id = requestOrId;
      } else if (typeof requestOrId === "object") {
        // Try different possible keys
        id =
          requestOrId.id ??
          requestOrId.requestId ??
          requestOrId.request_id ??
          requestOrId.friendRequestId ??
          requestOrId.requesterId ??
          null;
      }

      if (!id) {
        console.error("❌ Could not determine request id from:", requestOrId);
        return alert("Unable to accept request: missing request id");
      }

      console.log("📨 Accepting friend request with id:", id);

      const res = await fetch(`${API_BASE}/api/friend-requests/${encodeURIComponent(id)}/accept`, {
        method: "POST",
        headers: { "Content-Type": "application/json" }
      });

      if (!res.ok) {
        let errBody = null;
        try {
          errBody = await res.json();
        } catch {
          errBody = await res.text();
        }

        console.error("❌ Accept failed:", errBody);
        return alert("Accept failed: " + (errBody?.error || errBody || res.status));
      }

      console.log("✅ Accept success");

      // refresh UI
      if (userId) {
        await fetchFriends(userId);
        await fetchIncomingRequests(userId);
      }

      alert("Friend request accepted!");
    } catch (e) {
      console.error("❌ acceptRequest error:", e);
      alert("Error: " + (e.message || e));
    }
  };

  // messages
  const handleMessage = (e) => setUserData((prev) => ({ ...prev, message: e.target.value }));

  const sendPublicMessage = () => {
    if (!stompClient) return alert("Not connected");
    if (!userData.message) return;
    const chatMessage = { senderName: userData.username, message: userData.message, status: "MESSAGE" };
    stompClient.send("/app/message", {}, JSON.stringify(chatMessage));
    setUserData((prev) => ({ ...prev, message: "" }));
  };

  const sendPrivateMessage = () => {
    if (!stompClient) return alert("Not connected");
    if (!userData.message) return;
    if (tab === "CHATROOM") return alert("Select a friend to send private message");

    const chatMessage = {
      senderName: userData.username,
      senderMobile: mobile,
      receiverName: tab,
      receiverMobile: tab,
      message: userData.message,
      status: "MESSAGE"
    };

    // optimistic UI
    setPrivateChats((prev) => {
      const m = new Map(prev);
      const list = m.get(tab) ? [...m.get(tab), chatMessage] : [chatMessage];
      m.set(tab, list);
      return new Map(m);
    });

    stompClient.send("/app/private-message", {}, JSON.stringify(chatMessage));
    setUserData((prev) => ({ ...prev, message: "" }));
  };

  const handleSelectTab = (key) => setTab(key);
  const findFriendName = (mobileKey) => {
    const f = friends.find((x) => x.mobile === mobileKey);
    return f ? f.name || f.mobile : mobileKey;
  };

  // ------------- UI -------------
  return (
    <div className="container">
      {/* If not connected (websocket) show login/register */}
      {!userData.connected ? (
        <div className="register" style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          <input placeholder="Enter your mobile (+91...)" value={mobile} onChange={handleMobile} />
          <input placeholder="Enter your name (for registration)" value={userData.username} onChange={handleUsername} />

          <div style={{ display: "flex", gap: 8 }}>
            <button onClick={loginUser}>Login (mobile)</button>
            <button onClick={registerUser}>Register</button>
            <button onClick={() => { setUserData((p) => ({ ...p, username: "Demo" })); setMobile("+911234567890"); }}>Fill Demo</button>
          </div>

          <div style={{ fontSize: 13, color: "#666", marginTop: 8 }}>
            Use Login to sign in with your mobile. If you don't have an account, fill name + mobile and click Register.
          </div>
        </div>
      ) : (
        <div className="chat-box">
          {/* Left sidebar */}
          <div className="member-list">
            {/* search */}
            <div style={{ padding: "6px 4px" }}>
              <input placeholder="Search users (mobile/name)" value={searchQuery} onChange={(e) => searchUsers(e.target.value)} style={{ width: "100%", padding: 8, borderRadius: 8 }} />
              {searchResults.length > 0 && (
                <div style={{ marginTop: 8, maxHeight: 220, overflowY: "auto", background: "#fff", borderRadius: 8 }}>
                  {searchResults.map((sr) => (
                    <div key={sr.id} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: 8, borderBottom: "1px solid #eee" }}>
                      <div>
                        <div style={{ fontWeight: 700 }}>{sr.name || sr.mobile}</div>
                        <div style={{ fontSize: 12, color: "#666" }}>{sr.mobile}</div>
                      </div>
                      <div>
                        <button onClick={() => sendFriendRequest(sr.id)}>Request</button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* requests */}
            {requests.length > 0 && (
              <div style={{ padding: "6px 4px" }}>
                <div style={{ fontWeight: 700, marginBottom: 6 }}>Requests</div>
                <div>
                  {requests.map((r) => (
                    <div key={r.id || r.requestId || r.request_id} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: 8, borderBottom: "1px solid #f0f0f0" }}>
                      <div>
                        <div style={{ fontWeight: 700 }}>{r.fromName || r.fromMobile || r.requesterName || r.requesterMobile}</div>
                        <div style={{ fontSize: 12, color: "#666" }}>{r.fromMobile || r.requesterMobile}</div>
                      </div>
                      <div>
                        {/* pass full object so acceptRequest can extract id reliably */}
                        <button onClick={() => acceptRequest(r)}>Accept</button>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* friends */}
            <ul style={{ padding: 0, marginTop: 8 }}>
              <li onClick={() => handleSelectTab("CHATROOM")} className={`member ${tab === "CHATROOM" && "active"}`} style={{ listStyle: "none" }}>Chatroom</li>
              {[...privateChats.keys()].map((key, index) => {
                const name = findFriendName(key) || key;
                return (
                  <li key={index} onClick={() => handleSelectTab(key)} className={`member ${tab === key && "active"}`} style={{ listStyle: "none" }}>
                    {name}
                  </li>
                );
              })}
            </ul>
          </div>

          {/* Right chat area */}
          {tab === "CHATROOM" ? (
            <div className="chat-content">
              <ul className="chat-messages" ref={publicScrollRef} style={{ overflowY: "auto" }}>
                {publicChats.map((chat, idx) => (
                  <li key={idx} className={`message ${chat.senderName === userData.username ? "self" : ""}`}>
                    {chat.senderName !== userData.username && <div className="avatar">
                        {/* {chat.senderName?.charAt(0)} */}
                        </div>}
                    <div style={{ display: "flex", flexDirection: "column" }}>
                      <div style={{ fontSize: 12, color: "#666", marginBottom: 6 }}>{chat.receiverName ? `${chat.senderName} → ${chat.receiverName}` : chat.senderName}</div>
                      <div className="message-data">{chat.message}</div>
                    </div>
                    {/* {chat.senderName === userData.username && <div className="avatar self">{userData.username?.charAt(0)}</div>} */}
                  </li>
                ))}
              </ul>

              <div className="send-message">
                <input type="text" className="input-message" placeholder="enter the message" value={userData.message} onChange={handleMessage} />
                <button type="button" className="send-button" onClick={sendPublicMessage}>send</button>
              </div>
            </div>
          ) : (
            <div className="chat-content">
              <ul className="chat-messages" ref={privateScrollRef} style={{ overflowY: "auto" }}>
                {privateChats.get(tab) && [...privateChats.get(tab)].map((chat, idx) => (
                  <li key={idx} className={`message ${chat.senderName === userData.username ? "self" : ""}`}>
                    <div className="message-data">{chat.message}</div>
                  </li>
                ))}
                {(!privateChats.get(tab) || privateChats.get(tab).length === 0) && (
                  <div className="empty-state" style={{ padding: 16, color: "#666" }}>No messages yet with {findFriendName(tab)}</div>
                )}
              </ul>

              <div className="send-message">
                <input type="text" className="input-message" placeholder="enter the message" value={userData.message} onChange={handleMessage} />
                <button type="button" className="send-button" onClick={sendPrivateMessage}>send</button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
};

export default ChatRoom;
