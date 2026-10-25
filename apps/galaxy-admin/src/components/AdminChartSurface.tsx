'use client';

import {Component,type ReactNode} from 'react';

export function AdminChartLoading(){
  return <div className="analytics-chart-empty" role="status">正在加载图表…</div>;
}

// A chart chunk failure must not hide the surrounding controls or source values.
export class AdminChartSurface extends Component<{children:ReactNode},{failed:boolean}>{
  state={failed:false};
  static getDerivedStateFromError(){return {failed:true};}
  render(){
    return this.state.failed?<div className="analytics-chart-empty" role="status">图表暂时无法显示，数值见下表。</div>:this.props.children;
  }
}
