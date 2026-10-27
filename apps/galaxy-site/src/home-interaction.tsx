"use client";
import {useEffect} from 'react';
import {attachHomeExperience} from '../home-experience.js';
export function HomeInteraction(){
 useEffect(()=>attachHomeExperience(document.querySelector('.galaxy-home[data-home-example]')),[]);
 return null;
}
