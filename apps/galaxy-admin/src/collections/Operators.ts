import type {CollectionConfig} from 'payload';
import {isOperator,canReadOwnOperator,internalOperatorSync} from '../lib/access';
import {operatorStrategy} from '../lib/operator-strategy';

export const Operators:CollectionConfig={
  slug:'operators',labels:{singular:'运营成员',plural:'运营成员'},
  auth:{disableLocalStrategy:true,strategies:[operatorStrategy]},
  admin:{hidden:true,useAsTitle:'displayName'},
  access:{admin:({req})=>isOperator(req.user),read:canReadOwnOperator,create:internalOperatorSync,update:internalOperatorSync,delete:()=>false},
  fields:[
    {name:'externalId',label:'管理身份编号',type:'text',required:true,unique:true,index:true,admin:{readOnly:true}},
    {name:'displayName',label:'名称',type:'text',required:true,admin:{readOnly:true}},
    {name:'role',label:'登录资格',type:'select',required:true,options:[{label:'管理员资格',value:'administrator'},{label:'后台成员资格',value:'reader'}],admin:{readOnly:true}},
  ],
};
