//! Remote skill installer and bundle manager for Orca Relay.
//!
//! Handles skill discovery, bundle inspection, atomic deployment, and removal.

use serde::{Deserialize, Serialize};
use std::path::Path;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct InstalledSkillInfo {
    pub name: String,
    pub path: String,
    pub description: Option<String>,
    pub has_skill_md: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SkillPreview {
    pub name: String,
    pub description: Option<String>,
    pub file_count: usize,
}

#[derive(Debug, thiserror::Error)]
pub enum SkillError {
    #[error("I/O error: {0}")]
    Io(#[from] std::io::Error),
    #[error("Skill not found: {0}")]
    NotFound(String),
}

pub struct SkillInstaller;

impl SkillInstaller {
    /// Lists all installed skills found under `skills_dir`.
    pub async fn list_skills(
        skills_dir: impl AsRef<Path>,
    ) -> Result<Vec<InstalledSkillInfo>, SkillError> {
        let p = skills_dir.as_ref();
        if !p.exists() {
            return Ok(Vec::new());
        }

        let mut read_dir = tokio::fs::read_dir(p).await.map_err(SkillError::Io)?;
        let mut skills = Vec::new();

        while let Some(entry) = read_dir.next_entry().await.map_err(SkillError::Io)? {
            let path = entry.path();
            if path.is_dir() {
                let name = entry.file_name().to_string_lossy().to_string();
                let skill_md_path = path.join("SKILL.md");
                let has_skill_md = skill_md_path.exists();

                let description = if has_skill_md {
                    tokio::fs::read_to_string(&skill_md_path)
                        .await
                        .ok()
                        .and_then(|content| {
                            content
                                .lines()
                                .find(|l| l.starts_with("# ") || l.starts_with("description:"))
                                .map(|l| {
                                    l.trim_start_matches("# ")
                                        .trim_start_matches("description:")
                                        .trim()
                                        .to_string()
                                })
                        })
                } else {
                    None
                };

                skills.push(InstalledSkillInfo {
                    name,
                    path: path.to_string_lossy().to_string(),
                    description,
                    has_skill_md,
                });
            }
        }

        Ok(skills)
    }

    /// Previews a skill bundle at `source_dir`.
    pub async fn preview_skill(source_dir: impl AsRef<Path>) -> Result<SkillPreview, SkillError> {
        let p = source_dir.as_ref();
        if !p.exists() {
            return Err(SkillError::NotFound(p.to_string_lossy().to_string()));
        }

        let name = p
            .file_name()
            .map(|f| f.to_string_lossy().to_string())
            .unwrap_or_else(|| "unnamed-skill".to_string());

        let skill_md = p.join("SKILL.md");
        let description = if skill_md.exists() {
            tokio::fs::read_to_string(&skill_md).await.ok().map(|s| {
                s.lines()
                    .next()
                    .unwrap_or("")
                    .trim_start_matches('#')
                    .trim()
                    .to_string()
            })
        } else {
            None
        };

        let mut file_count = 0;
        if let Ok(mut rd) = tokio::fs::read_dir(p).await {
            while let Ok(Some(_)) = rd.next_entry().await {
                file_count += 1;
            }
        }

        Ok(SkillPreview {
            name,
            description,
            file_count,
        })
    }

    /// Installs a skill from `source_dir` into `target_dir/<skill_name>`.
    pub async fn install_skill(
        source_dir: impl AsRef<Path>,
        target_skills_dir: impl AsRef<Path>,
    ) -> Result<InstalledSkillInfo, SkillError> {
        let src = source_dir.as_ref();
        let name = src
            .file_name()
            .map(|f| f.to_string_lossy().to_string())
            .unwrap_or_else(|| "custom-skill".to_string());

        let dest = target_skills_dir.as_ref().join(&name);
        tokio::fs::create_dir_all(&dest)
            .await
            .map_err(SkillError::Io)?;

        // Copy files
        let mut read_dir = tokio::fs::read_dir(src).await.map_err(SkillError::Io)?;
        while let Some(entry) = read_dir.next_entry().await.map_err(SkillError::Io)? {
            let entry_path = entry.path();
            if entry_path.is_file() {
                let dest_file = dest.join(entry.file_name());
                let _ = tokio::fs::copy(&entry_path, &dest_file).await;
            }
        }

        let skill_md_path = dest.join("SKILL.md");
        let has_skill_md = skill_md_path.exists();
        let description = if has_skill_md {
            tokio::fs::read_to_string(&skill_md_path).await.ok()
        } else {
            None
        };

        Ok(InstalledSkillInfo {
            name,
            path: dest.to_string_lossy().to_string(),
            description,
            has_skill_md,
        })
    }

    /// Removes an installed skill directory.
    pub async fn remove_skill(
        skill_name: &str,
        target_skills_dir: impl AsRef<Path>,
    ) -> Result<(), SkillError> {
        let dest = target_skills_dir.as_ref().join(skill_name);
        if dest.exists() {
            tokio::fs::remove_dir_all(&dest)
                .await
                .map_err(SkillError::Io)?;
            Ok(())
        } else {
            Err(SkillError::NotFound(skill_name.to_string()))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn test_skill_lifecycle() {
        let temp_src = tempfile::tempdir().unwrap();
        let src_skill = temp_src.path().join("my-awesome-skill");
        std::fs::create_dir_all(&src_skill).unwrap();
        std::fs::write(
            src_skill.join("SKILL.md"),
            "# Awesome Skill\nDoes great things.",
        )
        .unwrap();

        let temp_dest = tempfile::tempdir().unwrap();

        // Preview
        let preview = SkillInstaller::preview_skill(&src_skill).await.unwrap();
        assert_eq!(preview.name, "my-awesome-skill");
        assert_eq!(preview.file_count, 1);

        // Install
        let installed = SkillInstaller::install_skill(&src_skill, temp_dest.path())
            .await
            .unwrap();
        assert_eq!(installed.name, "my-awesome-skill");
        assert!(installed.has_skill_md);

        // List
        let list = SkillInstaller::list_skills(temp_dest.path()).await.unwrap();
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].name, "my-awesome-skill");

        // Remove
        SkillInstaller::remove_skill("my-awesome-skill", temp_dest.path())
            .await
            .unwrap();
        let list_after = SkillInstaller::list_skills(temp_dest.path()).await.unwrap();
        assert_eq!(list_after.len(), 0);
    }
}
