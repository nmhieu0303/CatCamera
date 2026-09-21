export function isTrustedPullRequest(pullRequest, repository) {
  return pullRequest?.base?.repo?.full_name === repository && pullRequest?.head?.repo?.full_name === repository;
}

export function isStalePullRequest(initialSha, latestPullRequest) {
  return !latestPullRequest || latestPullRequest.state !== 'open' || latestPullRequest.head?.sha !== initialSha;
}
