export function renderDovecotAuthConf(): string {
  return [
    "disable_plaintext_auth = yes",
    "auth_mechanisms = plain login",
    "!include auth-passwdfile.conf.ext",
    ""
  ].join("\n");
}

export function renderDovecotLoggingConf(): string {
  return [
    "auth_verbose = no",
    "auth_debug = no",
    "auth_debug_passwords = no",
    ""
  ].join("\n");
}

export function renderDovecotMasterConf(): string {
  return [
    "service auth {",
    "  unix_listener /var/spool/postfix/private/auth {",
    "    mode = 0660",
    "    user = postfix",
    "    group = postfix",
    "  }",
    "}",
    ""
  ].join("\n");
}

export function renderDovecotPasswdConf(): string {
  return [
    "passdb {",
    "  driver = passwd-file",
    "  args = scheme=CRYPT username_format=%u /etc/dovecot/passwd.d/delivrix-smtp-users",
    "}",
    "userdb {",
    "  driver = static",
    "  args = uid=nobody gid=nogroup home=/var/empty",
    "}",
    ""
  ].join("\n");
}

export function renderPostfixMasterServiceCommands(): string {
  return [
    "postconf -M submission/inet='submission inet n - y - - smtpd'",
    "postconf -P submission/inet/syslog_name=postfix/submission",
    "postconf -P submission/inet/smtpd_tls_security_level=encrypt",
    "postconf -P submission/inet/smtpd_sasl_auth_enable=yes",
    "postconf -P submission/inet/smtpd_recipient_restrictions=permit_sasl_authenticated,reject",
    "postconf -M smtps/inet='smtps inet n - y - - smtpd'",
    "postconf -P smtps/inet/syslog_name=postfix/smtps",
    "postconf -P smtps/inet/smtpd_tls_wrappermode=yes",
    "postconf -P smtps/inet/smtpd_sasl_auth_enable=yes",
    "postconf -P smtps/inet/smtpd_recipient_restrictions=permit_sasl_authenticated,reject"
  ].join(" && ");
}
