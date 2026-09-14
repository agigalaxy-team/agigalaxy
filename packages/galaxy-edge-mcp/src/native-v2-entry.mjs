import {startNativeStdio} from './native-v2/stdio.mjs';
try{await startNativeStdio();}catch{process.stderr.write('Galaxy native configuration is missing or invalid. Set GALAXY_NATIVE_CONFIG to the reviewed public configuration.\n');process.exitCode=1;}
