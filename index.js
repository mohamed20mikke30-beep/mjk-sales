"use strict";

const crypto = require("node:crypto");
const { promisify } = require("node:util");
const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { setGlobalOptions } = require("firebase-functions/v2");
const { defineSecret } = require("firebase-functions/params");
const admin = require("firebase-admin");

admin.initializeApp();
setGlobalOptions({ region: "us-central1", maxInstances: 10 });

const db = admin.firestore();
const auth = admin.auth();
const scrypt = promisify(crypto.scrypt);
const credentialPepper = defineSecret("MJK_CREDENTIAL_PEPPER");
const COMPANY_ID = "mjk_company";
const PRIMARY_ADMIN_EMAIL = "mohamed40mikke50@gmail.com";
const CREDENTIALS_COLLECTION = "employeeCredentials";
const MAX_ASSIGNMENT = 2000;
const PASSWORD_BYTES = 64;

function normalizeEmail(value) {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

function emailKey(email) {
  return crypto.createHash("sha256").update(normalizeEmail(email)).digest("hex");
}

function passwordFingerprint(email, password) {
  const pepper = credentialPepper.value();
  if (!pepper || pepper.length < 32) {
    throw new HttpsError("failed-precondition", "لم يتم إعداد مفتاح حماية بيانات تسجيل الدخول.");
  }
  return crypto.createHmac("sha256", pepper)
    .update(`${normalizeEmail(email)}\u0000${password}`)
    .digest("hex");
}

function text(value, maxLength) {
  return typeof value === "string" ? value.trim().slice(0, maxLength) : "";
}

function credentialError(message = "البريد أو كلمة المرور غير صحيحة.") {
  return new HttpsError("not-found", message);
}

function requestIp(request) {
  return text(request.rawRequest?.ip || "unknown", 80);
}

async function consumeRateLimit(action, email, request, limit, windowMs) {
  const bucket = Math.floor(Date.now() / windowMs);
  const material = `${action}|${normalizeEmail(email)}|${requestIp(request)}|${bucket}`;
  const id = crypto.createHash("sha256").update(material).digest("hex");
  const ref = db.collection("authRateLimits").doc(id);
  await db.runTransaction(async transaction => {
    const snapshot = await transaction.get(ref);
    const count = snapshot.exists ? Number(snapshot.data().count) || 0 : 0;
    if (count >= limit) throw new HttpsError("resource-exhausted", "محاولات كثيرة. انتظر قليلًا ثم أعد المحاولة.");
    transaction.set(ref, { count: count + 1, expiresAt: new Date((bucket + 2) * windowMs) });
  });
}

async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const derived = await scrypt(password, salt, PASSWORD_BYTES, { N: 1 << 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
  return { salt: salt.toString("hex"), hash: Buffer.from(derived).toString("hex") };
}

async function passwordMatches(password, stored) {
  if (!stored || typeof stored.salt !== "string" || typeof stored.hash !== "string") return false;
  const actual = Buffer.from(await scrypt(password, Buffer.from(stored.salt, "hex"), PASSWORD_BYTES, {
    N: 1 << 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024
  }));
  const expected = Buffer.from(stored.hash, "hex");
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

async function requireCompanyAdmin(uid) {
  const snapshot = await db.collection("users").doc(uid).get();
  if (!snapshot.exists) throw new HttpsError("permission-denied", "حساب المدير غير مفعّل.");
  const profile = snapshot.data();
  if (profile.companyId !== COMPANY_ID || profile.role !== "admin" ||
      !["approved", "active"].includes(profile.status || "active")) {
    throw new HttpsError("permission-denied", "هذه العملية متاحة لمدير الشركة فقط.");
  }
  return profile;
}

exports.bootstrapPrimaryAdmin = onCall({ secrets: [credentialPepper] }, async request => {
  if (!request.auth) throw new HttpsError("unauthenticated", "سجّل الدخول أولًا.");
  const email = normalizeEmail(request.auth.token.email);
  if (email !== PRIMARY_ADMIN_EMAIL || request.auth.token.email_verified !== true) {
    throw new HttpsError("permission-denied", "تحقق من بريد المدير الأساسي قبل تهيئة مساحة الشركة.");
  }

  const userRef = db.collection("users").doc(request.auth.uid);
  const companyRef = db.collection("companies").doc(COMPANY_ID);
  const adminCredentials = db.collection(CREDENTIALS_COLLECTION).doc(emailKey(email)).collection("members");
  const credentialLockRef = db.collection("employeeCredentialLocks").doc(emailKey(email));
  const adminCredentialRef = adminCredentials.doc(request.auth.uid);
  const password = typeof request.data?.password === "string" ? request.data.password : "";
  if (password.length > 4096) throw new HttpsError("invalid-argument", "كلمة المرور طويلة جدًا.");
  const adminSecret = password ? await hashPassword(password) : null;
  const fingerprint = adminSecret ? passwordFingerprint(email, password) : "";
  const fingerprintRef = adminSecret
    ? db.collection("employeePasswordIndex").doc(fingerprint)
    : null;
  await db.runTransaction(async transaction => {
    const snapshot = await transaction.get(userRef);
    const companySnapshot = await transaction.get(companyRef);
    let currentAdminCredential = null;
    let fingerprintSnapshot = null;
    let oldFingerprintRef = null;
    if (adminSecret) {
      await transaction.get(credentialLockRef);
      currentAdminCredential = await transaction.get(adminCredentialRef);
      fingerprintSnapshot = await transaction.get(fingerprintRef);
      const oldFingerprint = currentAdminCredential.exists ? currentAdminCredential.data().fingerprint : "";
      if (oldFingerprint && oldFingerprint !== fingerprint) {
        oldFingerprintRef = db.collection("employeePasswordIndex").doc(oldFingerprint);
        await transaction.get(oldFingerprintRef);
      }
    }
    if (snapshot.exists) {
      const profile = snapshot.data();
      if (profile.companyId !== COMPANY_ID || profile.role !== "admin") {
        throw new HttpsError("permission-denied", "هذا الحساب لا يطابق ملف المدير الأساسي.");
      }
      if (profile.status !== "approved") {
        transaction.set(userRef, {
          status: "approved",
          role: "admin",
          companyId: COMPANY_ID,
          updatedAt: admin.firestore.FieldValue.serverTimestamp()
        }, { merge: true });
      }
    } else {
      if (!adminSecret) throw new HttpsError("failed-precondition", "أعد تسجيل الدخول لإنهاء تهيئة كلمة مرور المدير.");
      if (companySnapshot.exists && companySnapshot.data().primaryAdminUid !== request.auth.uid) {
        throw new HttpsError("permission-denied", "مساحة الشركة مرتبطة بحساب مدير أساسي آخر.");
      }
      transaction.create(userRef, {
        uid: request.auth.uid,
        email,
        fullName: text(request.auth.token.name, 100) || email,
        companyId: COMPANY_ID,
        role: "admin",
        status: "approved",
        createdAt: admin.firestore.FieldValue.serverTimestamp()
      });
    }
    if (adminSecret) {
      if (fingerprintSnapshot.exists && fingerprintSnapshot.data().uid !== request.auth.uid) {
        throw new HttpsError("already-exists", "كلمة مرور المدير يجب أن تكون مختلفة عن كلمات مرور الموظفين.");
      }
      if (oldFingerprintRef) transaction.delete(oldFingerprintRef);
      transaction.set(adminCredentialRef, {
        uid: request.auth.uid,
        email,
        role: "admin",
        salt: adminSecret.salt,
        hash: adminSecret.hash,
        fingerprint,
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
      }, { merge: true });
      transaction.set(fingerprintRef, { uid: request.auth.uid, role: "admin" });
      transaction.set(credentialLockRef, {
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
      }, { merge: true });
    }
    transaction.set(companyRef, {
      primaryAdminUid: request.auth.uid,
      primaryAdminEmail: email,
      ...(!companySnapshot.exists ? { createdAt: admin.firestore.FieldValue.serverTimestamp() } : {})
    }, { merge: true });
  });
  return { ok: true };
});

exports.registerEmployee = onCall({ secrets: [credentialPepper] }, async request => {
  const email = normalizeEmail(request.data?.email);
  const fullName = text(request.data?.fullName, 100);
  const password = typeof request.data?.password === "string" ? request.data.password : "";
  if (email !== PRIMARY_ADMIN_EMAIL) throw credentialError("استخدم بريد الشركة الأساسي لطلب الانضمام.");
  if (fullName.length < 2) throw new HttpsError("invalid-argument", "أدخل الاسم الكامل.");
  if (password.length < 12 || password.length > 128) {
    throw new HttpsError("invalid-argument", "يجب أن تتكون كلمة المرور من 12 إلى 128 حرفًا.");
  }
  await consumeRateLimit("register", email, request, 8, 60 * 60 * 1000);

  const companyRef = db.collection("companies").doc(COMPANY_ID);
  const company = await companyRef.get();
  if (!company.exists || company.data().primaryAdminEmail !== email) {
    throw new HttpsError("failed-precondition", "لم يتم تهيئة مساحة الشركة بعد.");
  }

  const key = emailKey(email);
  const membersRef = db.collection(CREDENTIALS_COLLECTION).doc(key).collection("members");
  const credentialLockRef = db.collection("employeeCredentialLocks").doc(key);
  const fingerprint = passwordFingerprint(email, password);
  const fingerprintRef = db.collection("employeePasswordIndex").doc(fingerprint);
  const adminCredential = await membersRef.doc(company.data().primaryAdminUid).get();
  if (!adminCredential.exists || adminCredential.data().role !== "admin") {
    throw new HttpsError("failed-precondition", "على المدير تسجيل الدخول مرة واحدة لإكمال إعداد حسابه.");
  }
  const uid = `mjk-employee-${crypto.randomUUID()}`;
  await auth.createUser({ uid, displayName: fullName });
  try {
    const secret = await hashPassword(password);
    const profileRef = db.collection("users").doc(uid);
    await db.runTransaction(async transaction => {
      await transaction.get(credentialLockRef);
      const existingFingerprint = await transaction.get(fingerprintRef);
      if (existingFingerprint.exists) {
        throw new HttpsError("already-exists", "اختر كلمة مرور مختلفة عن كلمات مرور الشركة.");
      }
      transaction.create(membersRef.doc(uid), {
        uid,
        email,
        salt: secret.salt,
        hash: secret.hash,
        fingerprint,
        createdAt: admin.firestore.FieldValue.serverTimestamp()
      });
      transaction.create(profileRef, {
        uid,
        email,
        fullName,
        companyId: COMPANY_ID,
        role: "pending",
        status: "pending",
        authType: "shared-company-email",
        createdAt: admin.firestore.FieldValue.serverTimestamp()
      });
        transaction.create(fingerprintRef, { uid, role: "employee" });
        transaction.set(credentialLockRef, { updatedAt: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });
    });
    const token = await auth.createCustomToken(uid);
    return { token };
  } catch (error) {
    await auth.deleteUser(uid).catch(deleteError => {
      console.error("Could not remove an incomplete employee Auth account:", deleteError);
    });
    throw error;
  }
});

exports.loginEmployee = onCall({ secrets: [credentialPepper] }, async request => {
  const email = normalizeEmail(request.data?.email);
  const password = typeof request.data?.password === "string" ? request.data.password : "";
  if (email !== PRIMARY_ADMIN_EMAIL || password.length < 1 || password.length > 128) {
    return { token: null };
  }
  await consumeRateLimit("login", email, request, 10, 15 * 60 * 1000);

  const fingerprint = passwordFingerprint(email, password);
  const indexedCredential = await db.collection("employeePasswordIndex").doc(fingerprint).get();
  if (!indexedCredential.exists || indexedCredential.data().role !== "employee") return { token: null };
  const uid = indexedCredential.data().uid;
  const member = await db.collection(CREDENTIALS_COLLECTION).doc(emailKey(email)).collection("members").doc(uid).get();
  if (!member.exists || !await passwordMatches(password, member.data())) return { token: null };
  const profile = await db.collection("users").doc(uid).get();
  if (!profile.exists || profile.data().companyId !== COMPANY_ID) return { token: null };
  return { token: await auth.createCustomToken(uid) };
});

exports.manageEmployee = onCall(async request => {
  if (!request.auth) throw new HttpsError("unauthenticated", "سجّل الدخول أولًا.");
  await requireCompanyAdmin(request.auth.uid);

  const uid = text(request.data?.uid, 128);
  const action = text(request.data?.action, 20);
  if (!uid || uid === request.auth.uid) throw new HttpsError("invalid-argument", "اختر موظفًا صالحًا.");
  const company = await db.collection("companies").doc(COMPANY_ID).get();
  if (company.exists && company.data().primaryAdminUid === uid) {
    throw new HttpsError("permission-denied", "لا يمكن تغيير صلاحية المدير الأساسي الدائمة.");
  }
  const userRef = db.collection("users").doc(uid);
  const snapshot = await userRef.get();
  if (!snapshot.exists || snapshot.data().companyId !== COMPANY_ID) {
    throw new HttpsError("not-found", "لم يُعثر على مستخدم ضمن الشركة.");
  }
  const profile = snapshot.data();
  if (action === "approve") {
    if (profile.status !== "pending") throw new HttpsError("failed-precondition", "لم يعد هذا الطلب معلّقًا.");
    const role = request.data?.role;
    const count = Number(request.data?.assignmentCount);
    if (!["admin", "agent"].includes(role) || !Number.isInteger(count) || count < 0 || count > MAX_ASSIGNMENT) {
      throw new HttpsError("invalid-argument", "الدور أو عدد جهات الاتصال غير صالح.");
    }

    const leadsRef = companyRefForLeads();
    let assigned = 0;
    if (count > 0) {
      const eligible = [];
      let cursor = null;
      while (eligible.length < count) {
        let query = leadsRef.where("companyId", "==", COMPANY_ID)
          .orderBy(admin.firestore.FieldPath.documentId()).limit(500);
        if (cursor) query = query.startAfter(cursor);
        const page = await query.get();
        if (page.empty) break;
        page.docs.forEach(lead => {
          if (eligible.length < count && (!lead.data().assignedTo || lead.data().assignedTo === uid) &&
              !lead.data().archived && lead.data().status !== "lost") eligible.push(lead);
        });
        cursor = page.docs[page.docs.length - 1];
      }
      for (let offset = 0; offset < eligible.length; offset += 450) {
        const batch = db.batch();
        eligible.slice(offset, offset + 450).forEach(lead => {
          batch.update(lead.ref, {
            assignedTo: uid,
            assignedAgentEmail: profile.email || "",
            companyId: COMPANY_ID,
            updatedAt: Date.now()
          });
        });
        await batch.commit();
        assigned += Math.min(450, eligible.length - offset);
      }
    }
    await userRef.update({
      role,
      status: "approved",
      assignedContactCount: assigned,
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    });
    return { ok: true, assigned };
  }

  if (action === "reject") {
    if (profile.status !== "pending") throw new HttpsError("failed-precondition", "لم يعد هذا الطلب معلّقًا.");
    await userRef.update({ status: "rejected", updatedAt: admin.firestore.FieldValue.serverTimestamp() });
    return { ok: true };
  }

  if (action === "role") {
    const role = request.data?.role;
    if (!["admin", "agent"].includes(role) ||
        !(["approved", "active"].includes(profile.status) || profile.status === undefined)) {
      throw new HttpsError("invalid-argument", "لا يمكن تعيين هذا الدور للحساب.");
    }
    await userRef.update({ role, updatedAt: admin.firestore.FieldValue.serverTimestamp() });
    return { ok: true };
  }

  if (action === "disable" || action === "reactivate") {
    if (["admin", "agent"].includes(profile.role) && action === "reactivate" && !["rejected", "disabled"].includes(profile.status)) {
      throw new HttpsError("failed-precondition", "الحساب ليس معطلًا.");
    }
    if (action === "disable" && !["approved", "active", undefined].includes(profile.status)) {
      throw new HttpsError("failed-precondition", "لا يمكن تعطيل هذا الحساب.");
    }
    const status = action === "disable" ? "disabled" : "approved";
    const role = ["admin", "agent"].includes(request.data?.role) ? request.data.role : profile.role;
    await userRef.update({ role, status, updatedAt: admin.firestore.FieldValue.serverTimestamp() });
    return { ok: true };
  }
  throw new HttpsError("invalid-argument", "إجراء إدارة غير معروف.");
});

function companyRefForLeads() {
  return db.collection("companies").doc(COMPANY_ID).collection("leads");
}
