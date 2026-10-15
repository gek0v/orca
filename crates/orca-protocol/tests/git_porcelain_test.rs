use orca_protocol::git_porcelain::parse_git_worktree_porcelain;

#[test]
fn test_parse_porcelain_with_locked_and_prunable() {
    let output = "worktree /repo/main\nHEAD 1111111111111111111111111111111111111111\nbranch refs/heads/main\n\nworktree /repo/locked\nHEAD 2222222222222222222222222222222222222222\nbranch refs/heads/feature\nlocked active agent session\n\nworktree /repo/prunable\nHEAD 3333333333333333333333333333333333333333\nbranch refs/heads/old\nprunable git dir gone\n";
    let list = parse_git_worktree_porcelain(output, false);
    assert_eq!(list.len(), 3);

    assert_eq!(list[0].path, "/repo/main");
    assert!(list[0].is_main);
    assert_eq!(list[0].branch.as_deref(), Some("main"));
    assert!(!list[0].locked);
    assert!(!list[0].prunable);

    assert_eq!(list[1].path, "/repo/locked");
    assert!(!list[1].is_main);
    assert_eq!(list[1].branch.as_deref(), Some("feature"));
    assert!(list[1].locked);
    assert_eq!(list[1].lock_reason.as_deref(), Some("active agent session"));

    assert_eq!(list[2].path, "/repo/prunable");
    assert!(!list[2].is_main);
    assert!(list[2].prunable);
    assert_eq!(list[2].prunable_reason.as_deref(), Some("git dir gone"));
}

#[test]
fn test_parse_porcelain_cquoted_paths() {
    let output = "worktree \"/repo/path with spaces\"\nHEAD aaaa\nbranch refs/heads/spaces\n\nworktree \"/repo/special\\nquote\"\nHEAD bbbb\ndetached\n";
    let list = parse_git_worktree_porcelain(output, false);
    assert_eq!(list.len(), 2);
    assert_eq!(list[0].path, "/repo/path with spaces");
    assert_eq!(list[1].path, "/repo/special\nquote");
    assert_eq!(list[1].branch.as_deref(), Some("detached"));
}

#[test]
fn test_parse_porcelain_nul_delimited() {
    let output = "worktree /repo/main\0HEAD 1111\0branch refs/heads/main\0\0worktree /repo/wt2\0HEAD 2222\0branch refs/heads/wt2\0locked \"raw quote\"\0\0";
    let list = parse_git_worktree_porcelain(output, true);
    assert_eq!(list.len(), 2);
    assert_eq!(list[0].path, "/repo/main");
    assert_eq!(list[1].path, "/repo/wt2");
    assert!(list[1].locked);
    assert_eq!(list[1].lock_reason.as_deref(), Some("\"raw quote\""));
}
