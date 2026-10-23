# Firebase cloud sync setup

The app loads Firebase Web SDK 10.8.0, Firebase Authentication
(email/password), Cloud Firestore, and Cloud Functions from Google's official CDN. PDF.js,
Tesseract.js, and Mammoth are also loaded from their configured CDNs. Its MJK
Sales web-app configuration is bundled in `index.html`, so no JSON setup is
needed in the app. Firebase web-app configuration is public client
configuration; never put a service-account JSON file or private key in client
code.

## Create and configure a Firebase project

1. Create a project in the Firebase console and add a **Web app**.
2. In **Authentication → Sign-in method**, enable **Email/Password**.
3. Create a **Cloud Firestore** database and enable billing for Cloud Functions.
4. From this folder, select the Firebase project with `firebase use --add`.
   Install backend dependencies with `npm install --prefix functions`.
5. Set the Functions secret `MJK_CREDENTIAL_PEPPER` to a randomly generated,
   private value of at least 32 characters:
   `firebase functions:secrets:set MJK_CREDENTIAL_PEPPER`.
   Do not put this value in `index.html` or commit it.
6. Deploy rules, indexes, and server functions with
   `firebase deploy --only firestore:rules,firestore:indexes,functions`.
7. In the app, use **تهيئة المدير الأساسي** with
   `mohamed40mikke50@gmail.com`, verify that email, and sign in. The server
   initializes `users/{authUid}` exactly once as `role: "admin"` and
   `status: "approved"` and saves the primary company owner UID. Do not create
   another primary admin profile manually.
8. Employees use **إنشاء حساب موظف** with the company email and a unique
   password of at least 12 characters. Cloud Functions hashes passwords with
   scrypt and uses the secret pepper for password lookup; plaintext passwords
   are not written to Firestore. Requests are stored as pending profiles in
   `mjk_company` until an admin approves them.
9. Configure Firestore TTL for `authRateLimits.expiresAt` to expire temporary
   login and registration rate-limit records.

If this company already has an administrator profile from the earlier client
flow, have the primary administrator sign out and sign in once after deploying Functions.
That upgrades the profile to permanent `approved` status and stores a hash of
the current admin password before employees can register with separate
passwords. The password itself is never stored.

An advanced optional setting is available for using a different Firebase
project. Leave it blank to use the bundled MJK Sales configuration.

## Company CRM and roles

Company leads are stored at `companies/{companyId}/leads/{leadId}` and
interaction history at each lead's `actions` subcollection. Every lead query
includes its `companyId`; shared-email employee queries additionally constrain
`assignedTo` to the employee's unique UID. Firestore rules are the security boundary; hiding
tabs or filtering cards in the browser is not a substitute for publishing the
rules.

Example primary administrator profile (created automatically by the server
after verified sign-in):

```json
{
  "uid": "FIREBASE_AUTH_UID",
  "email": "mohamed40mikke50@gmail.com",
  "fullName": "Primary Administrator",
  "companyId": "mjk_company",
  "role": "admin",
  "status": "approved"
}
```

The Admin panel's **User Approvals** view streams `users` documents for
`mjk_company`. Admins can approve pending users as `agent` (employee) or
`admin`, assign up to 2,000 unassigned contacts during approval, reject
requests, change active roles, disable accounts, or reactivate blocked users.
Role and status changes are performed by callable Cloud Functions; client
writes to user profiles are denied by Firestore rules.
The current project has no separate `portal.html`; employee navigation is
restricted in `index.html`, with matching server-side rules for company leads
and personal tool records.

Admins can also assign existing leads or batches. Shared-email employee
accounts use unique Firebase Auth UIDs, so an employee can read and update
only leads assigned to that UID, not all leads associated with the shared
company email. Lead records cannot be deleted through the client. Existing
unscoped leads are made visible only to company admins
and are copied into that admin's company on the first server sync; they are
not automatically assigned to agents. Local CRM caches are separated by user
and company.

## Company modules and integrations

The Admin panel's **Modules & Integrations** tab stores company-level
configuration at `companies/{companyId}/companySettings/features`. Admins can
toggle WhatsApp templates, Meta Lead Ads, VoIP/call initiation, quotations,
email templates, and advanced ROI metrics. Agents receive the same settings
through a real-time listener; local changes are queued while offline. The
Firestore rules permit company members to read these settings and only company
admins to create or update them.

WhatsApp opens a `wa.me` chat using the configured template. Quotations are
saved on the lead and can be printed or saved to PDF through the browser's
print dialog. Email actions open a prefilled `mailto:` draft. The VoIP action
initiates a `tel:` link and records that the action was initiated; it does not
record audio or confirm that a call connected.

Meta field mapping can preview a supplied JSON sample and import it as a lead.
The webhook URL is configuration for an external server-side connector; this
static web app does not receive Meta webhooks or call the configured endpoint.
Production webhook delivery, Meta signature verification, automated email
sending, and carrier call recording require a secured backend and the
corresponding provider credentials/services. Do not put provider secrets in
the browser.

## Data and offline behavior

Non-CRM tool data is written under `users/{Firebase Auth UID}/records/` and
is private to that signed-in account. Employee rules permit only their own
appointment and sales-script records; archive, name-verification, and filtering
records are denied to employee accounts. Company leads and actions use the
company-scoped paths documented above. The client listens to these collections
for real-time changes. For non-CRM records it reconciles changes using their
latest local edit timestamps. Local edits already queued or being written are
kept ahead of incoming snapshots; if needed, their version is advanced beyond
the observed cloud version before upload. Keep device clocks reasonably
accurate for resolving simultaneous edits made on different devices.

Local storage remains the working copy. Unsynced edits and deletions are queued
in local storage and begin uploading immediately after each successful local
save, without a debounce delay. Synchronization resumes when the device
reconnects. The
Firebase client also enables Firestore's IndexedDB persistence when the browser
supports it. Serve the page from HTTPS or localhost for the most reliable
Firebase authentication and offline-persistence behavior; a `file://` page may
be restricted by browser security policy.

Archived files are split into sub-1-MiB Firestore documents to stay under the
per-document limit. This does not make Firebase usage unconditionally free:
Firestore storage, reads, writes, network transfer, and Authentication remain
subject to Google's current quotas, terms, and billing settings. Keep Firebase
budget alerts enabled and review usage in the Firebase console.

The **Reset All Data** action clears only this device's local data and signs
out. It does not delete the Firebase copy. If the MJK configuration changes,
update `DEFAULT_FIREBASE_CONFIG` in `index.html`.

Appointment and follow-up reminders, and new employee alerts, ring only while
the dashboard is open. Grant browser notification permission and allow audio
after a user interaction; use **إيقاف التنبيه** to silence a repeating alert.
