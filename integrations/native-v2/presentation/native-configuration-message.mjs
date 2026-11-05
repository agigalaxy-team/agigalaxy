export function nativeConfigurationMessage(error,language='zh-CN'){
 const code=error?.code??error?.message, zh=language!=='en-US';
 if(code==='native_configuration_missing')return zh?'银河尚未完成本机接入。':'Galaxy has not been set up on this device.';
 if(['native_configuration_path_required','native_configuration_not_found','native_configuration_unreadable','native_configuration_too_large','native_configuration_invalid'].includes(code))return zh?'银河当前无法读取本机接入信息。':'Galaxy cannot read its local connection settings.';
 return zh?'银河暂时无法启动。':'Galaxy cannot start right now.';
}
