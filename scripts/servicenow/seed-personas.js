/* global GlideRecord, gs */
// Seeds the 7 demo.* personas of the plan (section 4.2) on dev420188.
// Run by Seun in System Definition > Scripts - Background, as admin (H16).
//
// Safe to run again: it only changes what differs. It touches users whose
// user_name starts with "demo." and nothing else (abel.tuter stays stock),
// never deletes a user, and prints one line per user: created, updated or
// unchanged. ES5 only (Rhino).

// Optional: a mailbox for demo.carol's email, so the goal-check reply email
// reaches Seun. Leave empty to keep demo.carol@example.com.
var REPLY_MAILBOX = "";

(function () {
  var PREFIX = "demo.";
  var PERSONAS = [
    { name: "alice", roles: ["snc_internal"], active: true },
    { name: "bob", roles: ["snc_internal"], active: true },
    { name: "carol", roles: ["snc_internal"], active: true },
    { name: "dave", roles: ["snc_internal"], active: true },
    { name: "erin", roles: ["snc_internal"], active: true },
    { name: "frank", roles: ["snc_internal", "itil"], active: true },
    { name: "gina", roles: ["snc_internal"], active: false }
  ];

  function flag(value) {
    return value === true || value === "true" || value === "1" || value === 1;
  }

  // Every write below passes through this check first.
  function requireDemo(userName) {
    if (String(userName).indexOf(PREFIX) !== 0) {
      throw new Error("refusing to touch a user that is not a demo.* persona");
    }
  }

  function query(table, field, value) {
    var gr = new GlideRecord(table);
    gr.addQuery(field, value);
    gr.query();
    return gr;
  }

  function roleId(name) {
    var role = query("sys_user_role", "name", name);
    if (!role.next()) throw new Error("role " + name + " does not exist on this instance");
    return String(role.getUniqueValue());
  }

  function emailFor(persona) {
    var mailbox = String(REPLY_MAILBOX).replace(/^\s+|\s+$/g, "");
    if (persona.name === "carol" && mailbox !== "") return mailbox;
    return PREFIX + persona.name + "@example.com";
  }

  function wantedFields(persona) {
    var first = persona.name.charAt(0).toUpperCase() + persona.name.slice(1);
    return {
      first_name: first,
      last_name: "Demo",
      email: emailFor(persona),
      active: persona.active,
      locked_out: false
    };
  }

  // Sets the fields that differ; returns true when anything changed.
  function applyFields(user, wanted, isNew) {
    var changed = false;
    for (var field in wanted) {
      if (!Object.prototype.hasOwnProperty.call(wanted, field)) continue;
      var want = wanted[field];
      var same =
        typeof want === "boolean"
          ? flag(user.getValue(field)) === want
          : String(user.getValue(field)) === want;
      // A new record has no value yet, so every field is set (sys_user defaults active to true).
      if (!same || isNew) {
        user.setValue(field, want);
        changed = true;
      }
    }
    return changed;
  }

  // Makes the user's direct roles exactly `persona.roles`. Inherited rows are left alone.
  function syncRoles(user, persona, ids) {
    requireDemo(user.getValue("user_name"));
    var userId = String(user.getUniqueValue());
    if (userId === "" || userId === "null" || userId === "undefined") {
      throw new Error("the user has no sys_id; roles were not touched");
    }
    var held = {};
    var changed = false;
    var rows = query("sys_user_has_role", "user", userId);
    while (rows.next()) {
      // A row that is not this user's own is never read as ours, let alone deleted.
      if (String(rows.getValue("user")) !== userId) {
        throw new Error("a role row of another user came back; nothing more was changed");
      }
      if (flag(rows.getValue("inherited"))) continue;
      var id = String(rows.getValue("role"));
      var wanted = false;
      for (var i = 0; i < persona.roles.length; i++) {
        if (ids[persona.roles[i]] === id) wanted = true;
      }
      if (wanted && !held[id]) {
        held[id] = true;
      } else {
        rows.deleteRecord();
        changed = true;
      }
    }
    for (var j = 0; j < persona.roles.length; j++) {
      var roleSysId = ids[persona.roles[j]];
      if (held[roleSysId]) continue;
      var add = new GlideRecord("sys_user_has_role");
      add.initialize();
      add.setValue("user", userId);
      add.setValue("role", roleSysId);
      add.insert();
      changed = true;
    }
    return changed;
  }

  function saveUser(user, persona, isNew, ids) {
    // The record's own user_name is checked before any field is set or written.
    requireDemo(isNew ? PREFIX + persona.name : user.getValue("user_name"));
    if (!isNew && String(user.getValue("user_name")) !== PREFIX + persona.name) {
      throw new Error("the record found is not the persona expected; nothing was changed");
    }
    var changed = applyFields(user, wantedFields(persona), isNew);
    if (isNew) {
      user.setValue("user_name", PREFIX + persona.name);
      var newId = user.insert();
      if (!newId || String(newId) === "null") throw new Error("the new user was not saved");
    } else if (changed) {
      user.update();
    }
    var rolesChanged = syncRoles(user, persona, ids);
    return isNew ? "created" : changed || rolesChanged ? "updated" : "unchanged";
  }

  var mailbox = String(REPLY_MAILBOX).replace(/^\s+|\s+$/g, "");
  if (mailbox !== "" && !/^[^\s@,;<>]+@[^\s@,;<>]+\.[^\s@,;<>]+$/.test(mailbox)) {
    gs.print("error: REPLY_MAILBOX is not a single email address; nothing was changed");
    return;
  }

  // Look every role up first, so a missing role stops the run before any write.
  var ids = {};
  for (var p = 0; p < PERSONAS.length; p++) {
    for (var r = 0; r < PERSONAS[p].roles.length; r++) {
      var roleName = PERSONAS[p].roles[r];
      if (!ids[roleName]) ids[roleName] = roleId(roleName);
    }
  }

  for (var n = 0; n < PERSONAS.length; n++) {
    var persona = PERSONAS[n];
    var userName = PREFIX + persona.name;
    var found = query("sys_user", "user_name", userName);
    var exists = found.next();
    var user = found;
    if (!exists) {
      user = new GlideRecord("sys_user");
      user.initialize();
    }
    gs.print(saveUser(user, persona, !exists, ids) + " " + userName);
  }
})();
