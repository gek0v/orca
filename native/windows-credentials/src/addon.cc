// Windows Credential Manager generic-credential access for Orca.
//
// Why native: the generic-credential blob is only reachable through advapi32
// CredReadW/CredWriteW/CredDeleteW. Shelling out (powershell.exe, cmdkey.exe,
// Add-Type P/Invoke) is the EDR-scored shape
// docs/reference/windows-edr-posture.md forbids, so this addon is the only
// sanctioned path. No shell, no flags, no interpreter hop.
//
// Errors never carry credential bytes: absent and denied both read as null,
// and failures throw fixed messages.

#include <napi.h>
#include <windows.h>
#include <wincred.h>

#include <string>
#include <vector>

namespace {

// Matches the credential codec ceiling: oversized blobs never reach the caller.
constexpr DWORD kMaxBlobBytes = 64 * 1024;
// Target names are short identifiers; cap well above any real one.
constexpr size_t kMaxTargetChars = 512;

bool TargetToWide(const Napi::Value& value, std::wstring* out) {
  if (!value.IsString()) {
    return false;
  }
  std::u16string narrow = value.As<Napi::String>().Utf16Value();
  if (narrow.empty() || narrow.size() > kMaxTargetChars) {
    return false;
  }
  // Utf16Value truncates at an embedded NUL, which would address the wrong
  // credential; reject instead.
  if (narrow.find(u'\0') != std::u16string::npos) {
    return false;
  }
  out->assign(reinterpret_cast<const wchar_t*>(narrow.data()), narrow.size());
  return true;
}

Napi::Value ReadCredential(const Napi::CallbackInfo& info) {
  auto env = info.Env();
  std::wstring target;
  if (info.Length() < 1 || !TargetToWide(info[0], &target)) {
    Napi::TypeError::New(env, "readCredential(target: string)").ThrowAsJavaScriptException();
    return env.Null();
  }

  PCREDENTIALW credential = nullptr;
  if (!CredReadW(target.c_str(), CRED_TYPE_GENERIC, 0, &credential)) {
    return env.Null();
  }
  if (credential->CredentialBlobSize > kMaxBlobBytes) {
    CredFree(credential);
    return env.Null();
  }
  auto blob = Napi::Buffer<BYTE>::Copy(
      env, credential->CredentialBlob, credential->CredentialBlobSize);
  CredFree(credential);
  return blob;
}

Napi::Value WriteCredential(const Napi::CallbackInfo& info) {
  auto env = info.Env();
  std::wstring target;
  if (info.Length() < 2 || !TargetToWide(info[0], &target) || !info[1].IsBuffer()) {
    Napi::TypeError::New(env, "writeCredential(target: string, blob: Buffer)")
        .ThrowAsJavaScriptException();
    return env.Null();
  }
  auto blob = info[1].As<Napi::Buffer<BYTE>>();
  if (blob.Length() > kMaxBlobBytes) {
    Napi::TypeError::New(env, "credential blob exceeds the size limit")
        .ThrowAsJavaScriptException();
    return env.Null();
  }

  // Read-modify-write: preserve the existing UserName, Comment and persistence
  // so the write changes the secret and nothing else about agy's own item.
  std::wstring userName = L"antigravity";
  std::wstring comment;
  DWORD persist = CRED_PERSIST_LOCAL_MACHINE;
  PCREDENTIALW existing = nullptr;
  if (CredReadW(target.c_str(), CRED_TYPE_GENERIC, 0, &existing)) {
    if (existing->UserName != nullptr) {
      userName.assign(existing->UserName);
    }
    if (existing->Comment != nullptr) {
      comment.assign(existing->Comment);
    }
    persist = existing->Persist;
    CredFree(existing);
  }

  CREDENTIALW credential = {};
  credential.Type = CRED_TYPE_GENERIC;
  credential.TargetName = const_cast<LPWSTR>(target.c_str());
  credential.CredentialBlobSize = static_cast<DWORD>(blob.Length());
  credential.CredentialBlob = blob.Data();
  credential.Persist = persist;
  credential.UserName = const_cast<LPWSTR>(userName.c_str());
  credential.Comment = comment.empty() ? nullptr : const_cast<LPWSTR>(comment.c_str());

  if (!CredWriteW(&credential, 0)) {
    return Napi::Boolean::New(env, false);
  }

  // Verify against a fresh read: a concurrent writer winning the race must not
  // look like success.
  PCREDENTIALW actual = nullptr;
  bool verified = false;
  if (CredReadW(target.c_str(), CRED_TYPE_GENERIC, 0, &actual)) {
    verified = actual->CredentialBlobSize == credential.CredentialBlobSize &&
               memcmp(actual->CredentialBlob, credential.CredentialBlob,
                      credential.CredentialBlobSize) == 0;
    CredFree(actual);
  }
  return Napi::Boolean::New(env, verified);
}

Napi::Value DeleteCredential(const Napi::CallbackInfo& info) {
  auto env = info.Env();
  std::wstring target;
  if (info.Length() < 1 || !TargetToWide(info[0], &target)) {
    Napi::TypeError::New(env, "deleteCredential(target: string)").ThrowAsJavaScriptException();
    return env.Null();
  }
  return Napi::Boolean::New(
      env, CredDeleteW(target.c_str(), CRED_TYPE_GENERIC, 0) ? true : false);
}

}  // namespace

Napi::Object Init(Napi::Env env, Napi::Object exports) {
  exports.Set("readCredential", Napi::Function::New(env, ReadCredential));
  exports.Set("writeCredential", Napi::Function::New(env, WriteCredential));
  exports.Set("deleteCredential", Napi::Function::New(env, DeleteCredential));
  return exports;
}

NODE_API_MODULE(orca_windows_credentials, Init)
