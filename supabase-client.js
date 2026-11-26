/**
 * Elevate Platform — Supabase Cloud Client Engine
 * Routes authentication through the auth-gateway Edge Function (no client-side
 * password verification or backdoors) and attaches the user's Supabase JWT to
 * all authenticated PostgREST, RPC, and Storage requests.
 */
(function (window) {
  "use strict";

  var SUPABASE_CONFIG = {
    url: "https://uhjstvlhlkcewmquhrnj.supabase.co",
    anonKey:
      "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InVoanN0dmxobGtjZXdtcXVocm5qIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTUzNzU3MDUsImV4cCI6MjExMDk1MTcwNX0.XpTZ-mxoY89WDcQ4dYzubev65hcxFOJ67iK7ikoVNuA",
  };

  var SESSION_KEY = "elevate_session";

  function readSession() {
    try {
      var raw = localStorage.getItem(SESSION_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch (e) {
      return null;
    }
  }

  function writeSession(session) {
    try {
      if (session && session.access_token) {
        localStorage.setItem(SESSION_KEY, JSON.stringify(session));
      } else {
        localStorage.removeItem(SESSION_KEY);
      }
    } catch (e) {}
  }

  function getAccessToken() {
    var s = readSession();
    return s && s.access_token ? s.access_token : SUPABASE_CONFIG.anonKey;
  }

  async function restRequest(endpoint, options) {
    options = options || {};
    var url = SUPABASE_CONFIG.url + "/rest/v1/" + endpoint;
    var token = getAccessToken();
    var headers = Object.assign(
      {
        apikey: SUPABASE_CONFIG.anonKey,
        Authorization: "Bearer " + token,
        "Content-Type": "application/json",
      },
      options.headers || {},
    );

    var controller = typeof AbortController !== "undefined" ? new AbortController() : null;
    var timeoutId = controller
      ? setTimeout(function () {
          controller.abort();
        }, 15000)
      : null;

    try {
      var res = await fetch(url, {
        method: options.method || "GET",
        headers: headers,
        body: options.body
          ? typeof options.body === "string"
            ? options.body
            : JSON.stringify(options.body)
          : undefined,
        signal: controller ? controller.signal : undefined,
      });
      if (timeoutId) clearTimeout(timeoutId);

      if (!res.ok) {
        var errText = "";
        try {
          errText = await res.text();
        } catch (e) {}
        throw new Error("Supabase Error (" + res.status + "): " + errText);
      }

      if (res.status === 204) return null;
      var text = await res.text();
      return text ? JSON.parse(text) : null;
    } catch (e) {
      if (timeoutId) clearTimeout(timeoutId);
      throw e;
    }
  }

  var ElevateSupabase = {
    config: SUPABASE_CONFIG,
    isReady: false,
    client: null,

    initClient: function () {
      if (window.supabase && typeof window.supabase.createClient === "function") {
        this.client = window.supabase.createClient(SUPABASE_CONFIG.url, SUPABASE_CONFIG.anonKey);
        var s = readSession();
        if (s && s.access_token && s.refresh_token) {
          this.client.auth
            .setSession({ access_token: s.access_token, refresh_token: s.refresh_token })
            .then(function (res) {
              if (res && res.data && res.data.session) {
                writeSession(res.data.session);
              }
            })
            .catch(function () {});
        }
      }
    },

    isAuthenticated: function () {
      var s = readSession();
      return !!(s && s.access_token);
    },

    getSession: readSession,

    setSession: function (session) {
      writeSession(session);
      if (this.client && session && session.access_token && session.refresh_token) {
        this.client.auth
          .setSession({ access_token: session.access_token, refresh_token: session.refresh_token })
          .catch(function () {});
      }
    },

    clearSession: function () {
      writeSession(null);
      if (this.client && this.client.auth) {
        this.client.auth.signOut().catch(function () {});
      }
    },

    callAuthGateway: async function (action, payload) {
      var body = Object.assign({ action: action }, payload || {});
      var res = await fetch(SUPABASE_CONFIG.url + "/functions/v1/auth-gateway", {
        method: "POST",
        headers: {
          apikey: SUPABASE_CONFIG.anonKey,
          Authorization: "Bearer " + getAccessToken(),
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      });
      var data = {};
      try {
        data = await res.json();
      } catch (e) {}
      if (!res.ok && !data.error) {
        data.error = "Auth request failed (" + res.status + ")";
      }
      return data;
    },

    login: async function (identifier, password, twofaCode) {
      var res = await this.callAuthGateway("login", {
        identifier: identifier,
        password: password,
        twofa_code: twofaCode,
      });
      if (res && res.ok && res.session) {
        this.setSession(res.session);
      }
      return res;
    },

    register: async function (payload) {
      var res = await this.callAuthGateway("register", payload);
      if (res && res.ok && res.session) {
        this.setSession(res.session);
      }
      return res;
    },

    googleLogin: async function (credential) {
      var res = await this.callAuthGateway("google_login", { credential: credential });
      if (res && res.ok && res.session) {
        this.setSession(res.session);
      }
      return res;
    },

    healthCheck: async function () {
      await restRequest("site_store?select=key&limit=1");
      this.isReady = true;
      return true;
    },

    getPublicStats: async function () {
      try {
        return await restRequest("rpc/get_public_stats", { method: "POST", body: {} });
      } catch (e) {
        return null;
      }
    },

    getMemberDirectory: async function () {
      if (!this.isAuthenticated()) return [];
      try {
        var rows = await restRequest("rpc/get_member_directory", { method: "POST", body: {} });
        return Array.isArray(rows) ? rows : [];
      } catch (e) {
        return [];
      }
    },

    fetchOpportunities: async function (options) {
      options = options || {};
      try {
        var endpoint = "opportunities?select=*&order=created_at.desc";
        if (options.limit) endpoint += "&limit=" + options.limit;
        if (options.category && options.category !== "all") {
          endpoint += "&category=eq." + encodeURIComponent(options.category);
        }
        var rows = await restRequest(endpoint);
        if (!Array.isArray(rows)) return [];
        return rows.map(function (row) {
          var dataObj = row.data && typeof row.data === "object" ? row.data : {};
          return Object.assign({}, dataObj, {
            id: row.id,
            title: row.title || dataObj.title || dataObj.name,
            name: dataObj.name || row.title || dataObj.title,
            category: row.category || dataObj.category || dataObj.type || "competitions",
            type: dataObj.type || row.category || "competitions",
            status: row.status || dataObj.status || "visible",
            created_at: row.created_at,
          });
        });
      } catch (e) {
        console.error("[ElevateSupabase] fetchOpportunities error:", e);
        return null;
      }
    },

    saveOpportunity: async function (opp) {
      if (!opp || !opp.id) throw new Error("Opportunity ID is required");
      var row = {
        id: String(opp.id),
        title: String(opp.title || opp.name || "Untitled"),
        category: String(opp.category || opp.type || "competitions"),
        status: String(opp.status || "visible"),
        data: opp,
        created_at: opp.created_at || new Date().toISOString(),
      };
      await restRequest("opportunities", {
        method: "POST",
        headers: { Prefer: "resolution=merge-duplicates,return=representation" },
        body: row,
      });
      return true;
    },

    deleteOpportunity: async function (id) {
      if (!id) return false;
      await restRequest("opportunities?id=eq." + encodeURIComponent(String(id)), {
        method: "DELETE",
      });
      return true;
    },

    fetchCourses: async function () {
      try {
        var rows = await restRequest("courses?select=*&order=created_at.desc");
        if (!Array.isArray(rows)) return [];
        return rows.map(function (row) {
          var dataObj = row.data && typeof row.data === "object" ? row.data : {};
          return Object.assign({}, dataObj, {
            id: row.id,
            title: row.title || dataObj.title,
            description: row.description || dataObj.description,
            instructor: row.instructor || dataObj.instructor || dataObj.teacherName,
            category: row.category || dataObj.category,
            level: row.level || dataObj.level,
            price: dataObj.price !== undefined ? dataObj.price : row.price || 0,
            image: row.image || dataObj.image || dataObj.thumbnail,
            created_at: row.created_at,
          });
        });
      } catch (e) {
        console.error("[ElevateSupabase] fetchCourses error:", e);
        return null;
      }
    },

    saveCourse: async function (course) {
      if (!course || !course.id) throw new Error("Course ID is required");
      var numericPrice = parseFloat(String(course.price || "0").replace(/[^0-9.]/g, "")) || 0;
      var row = {
        id: String(course.id),
        title: String(course.title || "Untitled"),
        description: course.description || "",
        instructor: course.instructor || course.teacherName || "",
        category: course.category || "",
        level: course.level || "",
        price: numericPrice,
        image: course.image || course.thumbnail || "",
        data: course,
        created_at: course.created_at || new Date().toISOString(),
      };
      await restRequest("courses", {
        method: "POST",
        headers: { Prefer: "resolution=merge-duplicates,return=representation" },
        body: row,
      });
      return true;
    },

    deleteCourse: async function (id) {
      if (!id) return false;
      await restRequest("courses?id=eq." + encodeURIComponent(String(id)), { method: "DELETE" });
      return true;
    },

    fetchCourseSubscriptions: async function () {
      if (!this.isAuthenticated()) return [];
      try {
        var rows = await restRequest("course_subscriptions?select=*&order=created_at.desc");
        return Array.isArray(rows) ? rows : [];
      } catch (e) {
        return [];
      }
    },

    addCourseSubscription: async function (sub) {
      return await restRequest("course_subscriptions", {
        method: "POST",
        headers: { Prefer: "resolution=merge-duplicates,return=representation" },
        body: {
          id: String(sub.id),
          course_id: String(sub.courseId),
          course_title: sub.courseTitle || "",
          identifier: String(sub.identifier),
          activated_at: sub.activatedAt || "",
          activated_by: sub.activatedBy || "",
        },
      });
    },

    removeCourseSubscription: async function (id) {
      await restRequest("course_subscriptions?id=eq." + encodeURIComponent(String(id)), {
        method: "DELETE",
      });
      return true;
    },

    fetchPartners: async function () {
      try {
        var rows = await restRequest("partners?select=*&order=created_at.desc");
        if (!Array.isArray(rows)) return [];
        return rows.map(function (row) {
          var dataObj = row.data && typeof row.data === "object" ? row.data : {};
          return Object.assign({}, dataObj, {
            id: row.id,
            name: row.name || dataObj.name,
            created_at: row.created_at,
          });
        });
      } catch (e) {
        return null;
      }
    },

    savePartner: async function (partner) {
      if (!partner || !partner.id) throw new Error("Partner ID is required");
      await restRequest("partners", {
        method: "POST",
        headers: { Prefer: "resolution=merge-duplicates,return=representation" },
        body: {
          id: String(partner.id),
          name: String(partner.name || "Untitled"),
          data: partner,
          created_at: partner.created_at || new Date().toISOString(),
        },
      });
      return true;
    },

    deletePartner: async function (id) {
      if (!id) return false;
      await restRequest("partners?id=eq." + encodeURIComponent(String(id)), { method: "DELETE" });
      return true;
    },

    fetchCommunityMessages: async function (limit) {
      limit = limit || 100;
      try {
        var rows = await restRequest(
          "community_messages?select=*&order=created_at.desc&limit=" + limit,
        );
        return Array.isArray(rows) ? rows.reverse() : [];
      } catch (e) {
        return [];
      }
    },

    sendCommunityMessage: async function (msg) {
      await restRequest("community_messages", {
        method: "POST",
        body: {
          id: String(msg.id),
          user_id: msg.userId || null,
          user_name: msg.senderName || "عضو",
          sender_username: msg.sender,
          sender_name: msg.senderName,
          role: msg.role || "member",
          role_title: msg.roleTitle || null,
          msg_type: msg.type || "text",
          content: String(msg.text || ""),
          media_url: msg.mediaUrl || null,
          reply_to: msg.replyTo || null,
          reactions: msg.reactions || {},
          timestamp: msg.timestamp || Date.now(),
        },
      });
      return true;
    },

    updateCommunityMessage: async function (id, newText) {
      await restRequest("community_messages?id=eq." + encodeURIComponent(String(id)), {
        method: "PATCH",
        body: { content: String(newText) },
      });
      return true;
    },

    deleteCommunityMessage: async function (id) {
      await restRequest("community_messages?id=eq." + encodeURIComponent(String(id)), {
        method: "DELETE",
      });
      return true;
    },

    fetchPrivateMessages: async function () {
      if (!this.isAuthenticated()) return [];
      try {
        var rows = await restRequest("private_messages?select=*&order=timestamp.asc&limit=500");
        return Array.isArray(rows) ? rows : [];
      } catch (e) {
        return [];
      }
    },

    sendPrivateMessage: async function (msg) {
      await restRequest("private_messages", {
        method: "POST",
        body: {
          id: String(msg.id),
          chat_key: String(msg.chatKey),
          sender_id: String(msg.senderId),
          sender_username: String(msg.sender),
          sender_name: msg.senderName || msg.sender,
          receiver_username: String(msg.receiver),
          msg_type: msg.type || "text",
          text: msg.text || "",
          media_url: msg.mediaUrl || null,
          reply_to: msg.replyTo || null,
          reactions: msg.reactions || {},
          timestamp: msg.timestamp || Date.now(),
        },
      });
      return true;
    },

    deletePrivateMessage: async function (id) {
      await restRequest("private_messages?id=eq." + encodeURIComponent(String(id)), {
        method: "DELETE",
      });
      return true;
    },

    toggleMessageReaction: async function (msgId, emoji, isPrivate) {
      return await restRequest("rpc/toggle_message_reaction", {
        method: "POST",
        body: { p_msg_id: String(msgId), p_emoji: String(emoji), p_is_private: Boolean(isPrivate) },
      });
    },

    fetchComments: async function (scope) {
      try {
        var ep = "item_comments?select=*&order=created_at.desc&limit=500";
        if (scope) ep += "&scope=eq." + encodeURIComponent(scope);
        var rows = await restRequest(ep);
        return Array.isArray(rows) ? rows : [];
      } catch (e) {
        return [];
      }
    },

    addComment: async function (comment) {
      return await restRequest("item_comments", {
        method: "POST",
        headers: { Prefer: "return=representation" },
        body: {
          id: String(comment.id),
          scope: String(comment.scope || "opp"),
          item_id: String(comment.itemId),
          user_id: comment.userId || null,
          username: String(comment.username || "guest"),
          display_name: String(comment.displayName || comment.username || "عضو"),
          text: String(comment.text),
          date_label: comment.dateLabel || "",
        },
      });
    },

    deleteComment: async function (id) {
      await restRequest("item_comments?id=eq." + encodeURIComponent(String(id)), {
        method: "DELETE",
      });
      return true;
    },

    fetchEngagements: async function (kind) {
      try {
        var ep = "item_engagements?select=*&limit=2000";
        if (kind) ep += "&kind=eq." + encodeURIComponent(kind);
        var rows = await restRequest(ep);
        return Array.isArray(rows) ? rows : [];
      } catch (e) {
        return [];
      }
    },

    recordEngagement: async function (kind, itemId, actorId, actorName, choice, toggle) {
      return await restRequest("rpc/record_item_engagement", {
        method: "POST",
        body: {
          p_kind: String(kind),
          p_item_id: String(itemId),
          p_actor_id: String(actorId || ""),
          p_actor_name: actorName || null,
          p_choice: choice || null,
          p_toggle: Boolean(toggle),
        },
      });
    },

    fetchPersonalData: async function () {
      if (!this.isAuthenticated()) return [];
      try {
        var rows = await restRequest("user_personal_data?select=key,value");
        return Array.isArray(rows) ? rows : [];
      } catch (e) {
        return [];
      }
    },

    savePersonalData: async function (userId, key, value) {
      if (!this.isAuthenticated() || !userId) return false;
      await restRequest("user_personal_data", {
        method: "POST",
        headers: { Prefer: "resolution=merge-duplicates" },
        body: { user_id: String(userId), key: String(key), value: value },
      });
      return true;
    },

    fetchSubmissions: async function () {
      if (!this.isAuthenticated()) return [];
      try {
        var rows = await restRequest("opportunity_submissions?select=*&order=created_at.desc");
        return Array.isArray(rows) ? rows : [];
      } catch (e) {
        return [];
      }
    },

    submitOpportunity: async function (sub) {
      await restRequest("opportunity_submissions", {
        method: "POST",
        body: {
          id: String(sub.id),
          data: sub,
          status: sub.status || "pending",
          submitted_by: sub.senderContact || sub.senderName || null,
        },
      });
      return true;
    },

    updateSubmissionStatus: async function (id, status, data) {
      await restRequest("opportunity_submissions?id=eq." + encodeURIComponent(String(id)), {
        method: "PATCH",
        body: data ? { status: status, data: data } : { status: status },
      });
      return true;
    },

    deleteSubmission: async function (id) {
      await restRequest("opportunity_submissions?id=eq." + encodeURIComponent(String(id)), {
        method: "DELETE",
      });
      return true;
    },

    fetchModerationReports: async function () {
      if (!this.isAuthenticated()) return [];
      try {
        var rows = await restRequest("moderation_reports?select=*&order=created_at.desc");
        return Array.isArray(rows) ? rows : [];
      } catch (e) {
        return [];
      }
    },

    createModerationReport: async function (id, kind, data) {
      await restRequest("moderation_reports", {
        method: "POST",
        body: { id: String(id), kind: String(kind), data: data },
      });
      return true;
    },

    deleteModerationReport: async function (id) {
      await restRequest("moderation_reports?id=eq." + encodeURIComponent(String(id)), {
        method: "DELETE",
      });
      return true;
    },

    fetchResetRequests: async function () {
      if (!this.isAuthenticated()) return [];
      try {
        var rows = await restRequest("password_reset_requests?select=*&order=created_at.desc");
        return Array.isArray(rows) ? rows : [];
      } catch (e) {
        return [];
      }
    },

    fetchAdminDevices: async function () {
      if (!this.isAuthenticated()) return [];
      try {
        var rows = await restRequest("admin_devices?select=*&order=updated_at.desc");
        return Array.isArray(rows) ? rows : [];
      } catch (e) {
        return [];
      }
    },

    saveAdminDevice: async function (device, userId) {
      if (!this.isAuthenticated()) return false;
      await restRequest("admin_devices", {
        method: "POST",
        headers: { Prefer: "resolution=merge-duplicates" },
        body: { id: String(device.id), user_id: String(userId), data: device },
      });
      return true;
    },

    deleteAdminDevice: async function (id) {
      await restRequest("admin_devices?id=eq." + encodeURIComponent(String(id)), {
        method: "DELETE",
      });
      return true;
    },

    fetchUsers: async function () {
      if (!this.isAuthenticated()) return [];
      try {
        var rows = await restRequest(
          "users?select=id,username,email,phone,full_name,is_admin,is_team,is_teacher,is_partner,teacher_name,partner_id,custom_role_title,perms,is_active,is_online,provider,avatar,join_date,join_timestamp,last_login,metadata&order=join_timestamp.desc",
        );
        return Array.isArray(rows) ? rows : [];
      } catch (e) {
        return [];
      }
    },

    fetchStore: async function () {
      try {
        var rows = await restRequest("site_store?select=key,value");
        var out = {};
        if (Array.isArray(rows)) {
          rows.forEach(function (r) {
            out[r.key] = r.value;
          });
        }
        return out;
      } catch (e) {
        return null;
      }
    },

    saveStoreKey: async function (key, value) {
      await restRequest("site_store", {
        method: "POST",
        headers: { Prefer: "resolution=merge-duplicates,return=representation" },
        body: {
          key: key,
          value: value,
          updated_at: new Date().toISOString(),
          source: "web_client",
        },
      });
      return true;
    },

    uploadFile: async function (bucket, path, fileOrBlob) {
      if (!this.client) throw new Error("Supabase SDK client not initialized");
      var res = await this.client.storage
        .from(bucket)
        .upload(path, fileOrBlob, { upsert: true, contentType: fileOrBlob.type || undefined });
      if (res.error) throw res.error;
      var pub = this.client.storage.from(bucket).getPublicUrl(path);
      return {
        path: path,
        publicUrl: pub && pub.data ? pub.data.publicUrl : "",
      };
    },

    getCourseMediaUrl: async function (courseId, kind) {
      var res = await this.callAuthGateway("get_course_media_url", {
        courseId: courseId,
        kind: kind || "video",
      });
      if (res && res.ok && res.url) return res.url;
      throw new Error((res && res.error) || "Failed to load media URL");
    },
  };

  ElevateSupabase.initClient();
  window.ElevateSupabase = ElevateSupabase;
})(window);
