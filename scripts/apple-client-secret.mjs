// Sign in with Apple needs AUTH_APPLE_SECRET to be a short-lived JWT signed with
// the .p8 key from the Apple Developer portal. Apple caps it at six months, so
// rerun this before it expires and set the new value on the deployment:
//   node scripts/apple-client-secret.mjs --team TEAMID --key KEYID --client com.example.web --p8 ./AuthKey_KEYID.p8
import { readFile } from "node:fs/promises";
import { importPKCS8, SignJWT } from "jose";

const options = {};
const argv = process.argv.slice(2);
for (let index = 0; index < argv.length; index += 2) {
  if (!argv[index].startsWith("--")) break;
  options[argv[index].slice(2)] = argv[index + 1];
}
const missing = ["team", "key", "client", "p8"].filter((name) => !options[name]);
if (missing.length > 0) {
  console.error(
    `missing --${missing.join(", --")}\nusage: node scripts/apple-client-secret.mjs --team TEAMID --key KEYID --client SERVICES_ID --p8 ./AuthKey_KEYID.p8`,
  );
  process.exit(2);
}

const privateKey = await importPKCS8(await readFile(options.p8, "utf8"), "ES256");
const issuedAt = Math.floor(Date.now() / 1000);
const secret = await new SignJWT({})
  .setProtectedHeader({ alg: "ES256", kid: options.key })
  .setIssuer(options.team)
  .setSubject(options.client)
  .setAudience("https://appleid.apple.com")
  .setIssuedAt(issuedAt)
  .setExpirationTime(issuedAt + 180 * 24 * 60 * 60 - 60)
  .sign(privateKey);
process.stdout.write(`${secret}\n`);
