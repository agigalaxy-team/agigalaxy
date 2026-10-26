#!/usr/bin/env python3
"""Reuse the Galaxy realm SMTP connection with the official notice identity.

No source realm/user or SMTP setting is changed. A single explicitly requested
test message may be sent; its receipt contains no addresses or credentials.
"""
import argparse
import datetime
from email.message import EmailMessage
from email.utils import formataddr, parseaddr, formatdate, make_msgid
import json
import os
from pathlib import Path
import re
import smtplib
import socket
import ssl
import subprocess
import sys
import urllib.parse
import urllib.request

from importlib.machinery import SourceFileLoader
support = SourceFileLoader('operations_stage', str(Path(__file__).with_name('stage-linux.py'))).load_module()
ROOT = Path('/etc/galaxy/operations-pilot')


def masked(value):
    return not isinstance(value, str) or not value or bool(re.fullmatch(r'\*+', value)) or value.lower() in ('__masked__', 'masked', '<secret>')


def read_smtp():
    bootstrap = json.loads(Path('/etc/galaxy/pilot/keycloak/runtime-secrets.json').read_text())
    data = urllib.parse.urlencode({'client_id': 'admin-cli', 'grant_type': 'password', 'username': bootstrap['bootstrapUsername'], 'password': bootstrap['bootstrapPassword']}).encode()
    request = urllib.request.Request('http://127.0.0.1:18080/realms/master/protocol/openid-connect/token', data=data)
    with urllib.request.urlopen(request, timeout=30) as response:
        token = json.load(response)['access_token']
    request = urllib.request.Request('http://127.0.0.1:18080/admin/realms/galaxy', headers={'Authorization': 'Bearer ' + token})
    with urllib.request.urlopen(request, timeout=30) as response:
        smtp = json.load(response)['smtpServer']
    fields = {'host', 'port', 'from', 'fromDisplayName', 'replyTo', 'replyToDisplayName', 'envelopeFrom', 'ssl', 'starttls', 'auth', 'user', 'password', 'authType'}
    smtp = {k: v for k, v in smtp.items() if k in fields}
    if smtp.get('auth') == 'true' and masked(smtp.get('password')):
        # Exact official JPA mapping: RealmEntity REALM_SMTP_CONFIG NAME/VALUE,
        # joined only to realm.name='galaxy'; no user or other realm data read.
        query = "SELECT json_object_agg(s.name,s.value) FROM realm_smtp_config s JOIN realm r ON r.id=s.realm_id WHERE r.name='galaxy' AND s.name IN ('host','port','from','fromDisplayName','replyTo','replyToDisplayName','envelopeFrom','ssl','starttls','auth','user','password','authType')"
        result = subprocess.run(['/usr/bin/docker', 'exec', '--user', 'postgres', 'galaxy-accounts-pilot-database-1', 'psql', '--no-psqlrc', '--no-password', '--tuples-only', '--no-align', '--set', 'ON_ERROR_STOP=1', '--host', '/var/run/postgresql', '--username', 'galaxy_accounts', '--dbname', 'galaxy_accounts', '--command', query], capture_output=True, text=True, timeout=30)
        if result.returncode:
            raise RuntimeError('operations_smtp_original_reference_unavailable')
        smtp = json.loads(result.stdout)
    if smtp.get('auth') == 'true' and (smtp.get('authType', 'basic').lower() not in ('basic', '') or masked(smtp.get('password'))):
        raise RuntimeError('operations_smtp_authentication_not_supported')
    if not smtp.get('host') or not smtp.get('from') or '@' not in smtp['from']:
        raise RuntimeError('operations_smtp_connection_incomplete')
    identity = json.loads(Path('/etc/galaxy/operations/monitoring/mail-identity.json').read_text())
    if identity.get('address') != 'notice@agigalaxy.org' or identity.get('replyTo') != 'team@agigalaxy.org' or identity.get('automated') is not True:
        raise RuntimeError('operations_mail_identity_invalid')
    smtp.update({'from': identity['address'], 'fromDisplayName': identity['name'],
                 'replyTo': identity['replyTo'], 'replyToDisplayName': 'AGI Galaxy 团队',
                 'envelopeFrom': identity['address']})
    return smtp


def configure(recipient, smtp):
    address = parseaddr(recipient)[1]
    if address != recipient or '@' not in address or re.search(r'[\r\n]', recipient):
        raise RuntimeError('operations_smtp_recipient_invalid')
    implicit = smtp.get('ssl') == 'true'
    if not implicit and smtp.get('starttls') != 'true':
        raise RuntimeError('operations_smtp_starttls_required')
    email = {'to': address, 'from': formataddr((smtp['fromDisplayName'], smtp['from'])),
             'headers': {'Reply-To': formataddr((smtp['replyToDisplayName'], smtp['replyTo']))},
             'smarthost': smtp['host'] + ':' + str(int(smtp.get('port', '465' if implicit else '587'))), 'require_tls': True, 'force_implicit_tls': implicit, 'send_resolved': True}
    templates = Path('/etc/galaxy/operations/monitoring')
    email['html'] = (templates / 'galaxy-email.html').read_text()
    email['text'] = (templates / 'galaxy-email.txt').read_text()
    if smtp.get('auth') == 'true':
        email.update(auth_username=smtp['user'], auth_password=smtp['password'])
    config = {'global': {'resolve_timeout': '5m'}, 'route': {'receiver': 'management', 'group_by': ['alertname', 'job', 'instance', 'owner_role'], 'group_wait': '30s', 'group_interval': '5m', 'repeat_interval': '4h'}, 'receivers': [{'name': 'management', 'email_configs': [email]}]}
    support.private_file(ROOT / 'alertmanager.json', json.dumps(config) + '\n')
    return {'state': 'configured', 'receiverConfigurationFile': str(ROOT / 'alertmanager.json'), 'recipientCount': 1, 'sourceRealm': 'galaxy', 'sourceChanged': False, 'authentication': smtp.get('auth') == 'true', 'implicitTls': implicit, 'starttls': not implicit}


def send_test(recipient, smtp):
    receipt = ROOT / 'alert-test-receipt.json'
    if receipt.exists():
        # A lost send ACK is not permission to send another test automatically.
        return {'state': 'not-repeated', 'receiptState': json.loads(receipt.read_text()).get('state')}
    at = datetime.datetime.now(datetime.timezone.utc).isoformat()
    support.private_file(receipt, json.dumps({'state': 'requested', 'requestedAt': at}) + '\n')
    message = EmailMessage()
    message['From'] = formataddr((smtp['fromDisplayName'], smtp['from']))
    message['Reply-To'] = formataddr((smtp['replyToDisplayName'], smtp['replyTo']))
    message['To'] = recipient
    message['Subject'] = '[AGI Galaxy] 运行告警投递测试 / Monitoring delivery test'
    message['Date'] = formatdate(localtime=False)
    message['Message-ID'] = make_msgid(domain=smtp['from'].rsplit('@', 1)[1])
    templates = Path('/etc/galaxy/operations/monitoring')
    message.set_content((templates / 'galaxy-test-email.txt').read_text())
    message.add_alternative((templates / 'galaxy-test-email.html').read_text(), subtype='html')
    try:
        implicit = smtp.get('ssl') == 'true'
        connection = smtplib.SMTP_SSL(smtp['host'], int(smtp.get('port', '465')), timeout=30, context=ssl.create_default_context()) if implicit else smtplib.SMTP(smtp['host'], int(smtp.get('port', '587')), timeout=30)
        with connection:
            connection.ehlo()
            if not implicit:
                connection.starttls(context=ssl.create_default_context())
                connection.ehlo()
            if smtp.get('auth') == 'true':
                connection.login(smtp['user'], smtp['password'])
            refused = connection.send_message(message, from_addr=smtp.get('envelopeFrom') or smtp['from'], to_addrs=[recipient])
            if refused:
                raise RuntimeError('operations_smtp_recipient_rejected')
        outcome = {'state': 'accepted-by-smtp', 'requestedAt': at, 'finishedAt': datetime.datetime.now(datetime.timezone.utc).isoformat(), 'recipientCount': 1, 'inboxReceiptVerified': False}
        support.private_file(receipt, json.dumps(outcome) + '\n')
        return outcome
    except Exception as error:
        support.private_file(receipt, json.dumps({'state': 'failed-or-unknown', 'requestedAt': at, 'errorType': type(error).__name__}) + '\n')
        raise


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--config', required=True, help='Absolute path to the protected target configuration')
    parser.add_argument('--recipient')
    parser.add_argument('--send-test', action='store_true')
    parser.add_argument('--metadata-only', action='store_true')
    args = parser.parse_args()
    config = json.loads(support.safe_path(args.config).read_text())
    if os.geteuid() != 0 or socket.gethostname() != config['targetHostname']:
        raise RuntimeError('operations_target_host_mismatch')
    smtp = read_smtp()
    if args.metadata_only:
        return {'state': 'source-readable', 'authentication': smtp.get('auth') == 'true', 'authType': smtp.get('authType', 'basic'), 'implicitTls': smtp.get('ssl') == 'true', 'starttls': smtp.get('starttls') == 'true', 'port': int(smtp.get('port', '587')), 'passwordResolved': smtp.get('auth') != 'true' or not masked(smtp.get('password'))}
    if not args.recipient:
        raise RuntimeError('operations_smtp_recipient_required')
    result = configure(args.recipient, smtp)
    if args.send_test:
        result['test'] = send_test(args.recipient, smtp)
    support.save_state('smtp', result)
    return result


if __name__ == '__main__':
    try:
        print(json.dumps(main()))
    except Exception as error:
        code = str(error)
        print(json.dumps({'state': 'failed', 'errorCode': code if code.startswith('operations_') else type(error).__name__}))
        raise SystemExit(1)
