package runtimeconfig

// ObserveRelease captures the verified result itself. No release reference is
// synthesized from a package version, environment label or intended rollout.
func (s *LoadedSources) ObserveRelease(release *ServiceRelease) { s.Release = release.Observation() }
