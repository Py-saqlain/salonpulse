import {Component} from 'react';
import type {ReactNode} from 'react';
export class ScreenBoundary extends Component<{children:ReactNode;onDismiss?:()=>void},{failed:boolean}> {
 state={failed:false};
 static getDerivedStateFromError(){return {failed:true};}
 render(){return this.state.failed?<section className="panel empty-appointments" role="alert"><h2>This screen could not load</h2><p>Check your connection. Reloading will require signing in again; unsaved inputs will be lost.</p><button className="secondary-button" onClick={()=>window.location.reload()}>Reload application</button>{this.props.onDismiss&&<button className="filter-reset" onClick={this.props.onDismiss}>Cancel</button>}</section>:this.props.children;}
}
