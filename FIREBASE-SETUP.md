# Firebase cloud sync setup

The app uses Firebase Web SDK 13.0.0, Firebase Authentication (email/password),
and Cloud Firestore. The Firebase web-app configuration is stored in this
browser's local storage. It is public client configuration; never paste a
service-account JSON file or private key into the app.

## Create and configure a Firebase project

1. Create a project in the Firebase console and add a **Web app**.
2. In **Authentication → Sign-in method**, enable **Email/Password**.
3. Create a **Cloud Firestore** database.
4. Open the Firestore **Rules** tab, replace the rules with the contents of
   [`firestore.rules`](./firestore.rules), and publish them.
5. In the app, open **Cloud Sync / Login**, paste the web app's config object
   (including `apiKey`, `authDomain`, `projectId`, and `appId`), and save it.
6. Register an email/password account or sign in. Sign in with that same account
   on each device to sync its data.

## Data and offline behavior

Documents are written under `users/{Firebase Auth UID}/records/`. Firestore
rules restrict each signed-in user to their own UID path. The client listens to
that records collection for real-time changes and reconciles records using their
latest local edit timestamps. Keep device clocks reasonably accurate.

Local storage remains the working copy. Unsynced edits and deletions are queued
in local storage, and synchronization resumes when the device reconnects. The
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
out. It does not delete the Firebase copy.
