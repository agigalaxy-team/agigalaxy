import {registerHooks} from 'node:module';

// SSR assertions exercise component markup; styles are compiled by Next build.
registerHooks({load(url,context,next){
 if(url.endsWith('.css'))return{format:'module',source:'export {};',shortCircuit:true};
 return next(url,context);
}});
