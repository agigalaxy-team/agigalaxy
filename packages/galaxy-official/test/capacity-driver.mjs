import autocannon from 'autocannon';

// Synthetic requests arrive over local IPC; no target/credential/body is logged.
process.once('message',async input=>{
  try{
    const url=new URL(input.url);
    if(url.protocol!=='http:'||url.hostname!=='127.0.0.1')throw new Error('Loopback required');
    let lane=0;
    const cpu=process.cpuUsage();
    const result=await autocannon({url:input.url,connections:input.lanes.length,amount:input.lanes.reduce((sum,items)=>sum+items.length,0),
      ...(input.overallRate===undefined?{}:{overallRate:input.overallRate}),
      pipelining:1,timeout:10,setupClient:client=>client.setRequests(input.lanes[lane++])});
    process.send({ok:true,result:{connections:result.connections,durationSeconds:result.duration,requestedRate:input.overallRate??null,
      responses:result.requests.total,requestsPerSecond:result.requests.average,latencyMs:result.latency,
      responseBytes:result.throughput.total,statusCodes:result.statusCodeStats,errors:result.errors,timeouts:result.timeouts,
      generatorCpuMicroseconds:process.cpuUsage(cpu),generatorMaxRssKiB:process.resourceUsage().maxRSS}});
  }catch{process.send({ok:false,error:'capacity_driver_failed'});}
  finally{process.disconnect();}
});
