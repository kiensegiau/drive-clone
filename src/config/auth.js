const credentials = {
  client_id:
    "58168105452-b1ftgklngm45smv9vj417t155t33tpih.apps.googleusercontent.com",
  project_id: "annular-strata-438914-c0",
  auth_uri: "https://accounts.google.com/o/oauth2/auth",
  token_uri: "https://oauth2.googleapis.com/token",
  auth_provider_x509_cert_url: "https://www.googleapis.com/oauth2/v1/certs",
  client_secret: "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",
  redirect_uris: ["http://localhost:3000/api/auth/google-callback"],
};

const SCOPES = [
  "https://www.googleapis.com/auth/drive",
  "https://www.googleapis.com/auth/drive.file",
  "https://www.googleapis.com/auth/drive.readonly",
  "https://www.googleapis.com/auth/drive.metadata.readonly",
];

module.exports = {
  credentials,
  SCOPES,
};
