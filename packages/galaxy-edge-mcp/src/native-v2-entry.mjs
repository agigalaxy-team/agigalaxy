import {startNativeStdio} from './native-v2/stdio.mjs';
import {nativeConfigurationMessage} from './native-v2/configuration.mjs';
try{await startNativeStdio();}catch(error){process.stderr.write(nativeConfigurationMessage(error)+'\n');process.exitCode=1;}
