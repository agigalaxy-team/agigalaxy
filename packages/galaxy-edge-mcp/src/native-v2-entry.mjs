import {startNativeStdio} from './native-v2/stdio.mjs';
import {nativeConfigurationMessage} from './native-v2/configuration.mjs';
import {nativeDiagnostics} from './native-v2/diagnostics.mjs';
import {installRuntimeFailureHandlers} from '../../galaxy-official/src/shared/runtime-logger.mjs';
let product;
const diagnostics=nativeDiagnostics();
const uninstall=installRuntimeFailureHandlers({logger:input=>(product?.diagnostics??diagnostics).emit({event:'native_runtime',stage:'shutdown',outcome:'failed',error:input.error}),onFatal:async()=>{try{await product?.close();}finally{uninstall();}}});
try{product=await startNativeStdio();}catch(error){diagnostics.emit({event:'native_runtime',stage:'runtime',outcome:'failed',error});process.stderr.write(nativeConfigurationMessage(error)+'\n');process.exitCode=1;uninstall();}
