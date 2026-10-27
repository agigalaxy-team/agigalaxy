import './shared/feedback/control-feedback.css';
import React from "react";
import {createRoot} from "react-dom/client";
import {StandaloneGalaxy} from "./standalone-galaxy";
createRoot(document.getElementById("root")!).render(<StandaloneGalaxy/>);
