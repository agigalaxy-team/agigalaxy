import SMTPConnection from 'nodemailer/lib/smtp-connection';
import MailComposer from 'nodemailer/lib/mail-composer';
import {renderGalaxyEmail} from "../../../../galaxy-mail/src/layout.mjs";
import {officialMailIdentity} from "../../../../galaxy-mail/src/identities.mjs";

const safeAuthorizationCodes=new Set(['operations_permission_denied','business_admin_denied','identity_directory_unavailable','smtp_configuration_changed','operations_messaging_not_active','operations_messaging_recipient_ineligible','operations_messaging_execution_interrupted']);
const validEmail=x=>typeof x==='string'&&x.length<=320&&/^[^\s@<>\r\n]+@[^\s@<>\r\n]+$/.test(x);

// A single phase hook around the pinned Nodemailer 10.1.7 SMTP state machine.
// The library still handles EHLO, TLS, authentication, envelopes and MIME DATA.
// Send the one-recipient envelope sequentially so current authorization is
// checked after RCPT acknowledgement, immediately before the DATA command.
class AuthorizedSmtpConnection extends SMTPConnection{
 constructor(options,authorize){super(options);this.galaxyAuthorize=authorize;this.galaxyBodyStarted=false;this.galaxyAuthorizationCode=null;}
 _sendCommand(command,masked){
  if(command!=='DATA')return super._sendCommand(command,masked);
  Promise.resolve().then(()=>this.galaxyAuthorize()).then(()=>{
   if(!this._destroyed)super._sendCommand(command,masked);
  }).catch(error=>{
   this.galaxyAuthorizationCode=safeAuthorizationCodes.has(error?.code)?error.code:'smtp_authorization_changed';
   this._onError(new Error('SMTP authorization changed'),'EAUTHZ',false,'DATA');
  });
 }
 _actionDATA(response,callback){
  if(/^[23]/.test(response)&&this._envelope?.accepted?.length)this.galaxyBodyStarted=true;
  return super._actionDATA(response,callback);
 }
}
function safeFailure(error,connection){
 if(connection.galaxyAuthorizationCode)return {submission:'failed',code:connection.galaxyAuthorizationCode,retryable:true};
 const response=Number(error?.responseCode);
 if(Number.isInteger(response)&&response>=400&&response<=599)return {submission:'failed',code:response<500?'smtp_temporary_rejection':'smtp_permanent_rejection',retryable:response<500};
 if(connection.galaxyBodyStarted)return {submission:'unknown',code:'smtp_submission_unknown',retryable:false};
 const codes={EAUTH:'smtp_authentication_failed',ETLS:'smtp_tls_failed',ECONNECTION:'smtp_connection_failed',ESOCKET:'smtp_connection_failed',ETIMEDOUT:'smtp_timeout',EDNS:'smtp_dns_failed',EPROTOCOL:'smtp_protocol_failed'};
 return {submission:'failed',code:codes[error?.code]??'smtp_transport_failed',retryable:['ECONNECTION','ESOCKET','ETIMEDOUT','EDNS'].includes(error?.code)};
}

export function createOperationsSmtpTransport({allowLoopbackPlaintext=false}={}){
 function options(config){
  const isolated=allowLoopbackPlaintext&&['127.0.0.1','localhost'].includes(config.host);
  return {host:config.host,port:config.port,secure:!isolated&&config.tls==='implicit',requireTLS:!isolated&&config.tls==='starttls',
   ignoreTLS:isolated,opportunisticTLS:false,connectionTimeout:config.connectionTimeoutMs,greetingTimeout:config.greetingTimeoutMs,
   socketTimeout:config.socketTimeoutMs,tls:{rejectUnauthorized:true,minVersion:'TLSv1.2',servername:config.host},
   logger:false,debug:false,transactionLog:false};
 }
 async function connected(config,credentials,authorize,operation){
  if(typeof authorize!=='function')return {submission:'failed',code:'smtp_authorization_unavailable',retryable:false};
  const connection=new AuthorizedSmtpConnection(options(config),authorize);
  return new Promise(resolve=>{
   let settled=false;
   const finish=result=>{if(settled)return;settled=true;connection.close();resolve(result);};
   const failed=error=>finish(safeFailure(error,connection));
   connection.on('error',failed);
   connection.connect(error=>{
    if(error)return failed(error);
    connection.login(credentials,error=>{
     if(error)return failed(error);
     // Nodemailer 10.1.7 pipelines DATA with MAIL/RCPT when advertised. A single
     // recipient gains little from that batch, and a fresh gate needs the last
     // recipient reply rather than the earlier envelope-construction point.
     connection._supportedExtensions=connection._supportedExtensions.filter(value=>value!=='PIPELINING');
     Promise.resolve().then(()=>operation(connection,finish,failed)).catch(failed);
    });
   });
  });
 }
 return Object.freeze({
  async verify(config,{credentials,authorize}){
   return connected(config,credentials,authorize,async(_connection,finish)=>{
    await authorize();finish({submission:'connected',code:null,retryable:false});
   });
  },
  async submit(config,{credentials,authorize,to,senderKey,subject,title,paragraphs,note='',language='zh-CN',messageId}){
   if(!validEmail(to)||!/^<[A-Za-z0-9._-]{1,200}@(messages\.)?agigalaxy\.org>$/.test(messageId??''))return {submission:'failed',code:'smtp_message_invalid',retryable:false};
   const identity=officialMailIdentity(senderKey);
   const rendered=renderGalaxyEmail({subject,title,paragraphs,note,language,automated:identity.automated});
   const message=new MailComposer({from:{name:identity.name,address:identity.address},replyTo:{name:'AGI Galaxy 团队',address:identity.replyTo},
    to,subject:rendered.subject,html:rendered.html,text:rendered.text,messageId,
    headers:identity.automated?{'Auto-Submitted':'auto-generated'}:{},disableFileAccess:true,disableUrlAccess:true}).compile();
   return connected(config,credentials,authorize,(connection,finish,failed)=>{
    const stream=message.createReadStream();
    stream.on('error',failed);
    connection.send({from:identity.address,to:[to]},stream,(error,result)=>{
     stream.destroy();
     if(error)return failed(error);
     if(!result?.accepted?.length)return finish({submission:'failed',code:'smtp_recipient_rejected',retryable:false});
     finish({submission:'submitted',code:null,retryable:false});
    });
   });
  },
 });
}
