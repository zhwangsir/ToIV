package model

import "time"

// Workspace is the single durable ownership root of a native installation.
// Existing user_id columns store this ID until their physical column names can
// be changed without rewriting every large local table in one release.
type Workspace struct {
	ID        string    `json:"id" gorm:"primaryKey;size:36"`
	Name      string    `json:"name" gorm:"size:80;not null"`
	CreatedAt time.Time `json:"createdAt"`
	UpdatedAt time.Time `json:"updatedAt"`
}

// WorkspaceIdentity binds an external identity (the ToIV user id asserted by the trusted
// Next proxy) to the workspace that owns that user's rows (M7 multi-tenant). New users get
// a fresh empty workspace whose id equals their ToIV id; the migration binds the platform
// admin to the pre-existing shared workspace so its data stays where it is.
type WorkspaceIdentity struct {
	Subject     string    `json:"subject" gorm:"primaryKey;size:64"`
	WorkspaceID string    `json:"workspaceId" gorm:"size:36;not null;uniqueIndex:idx_workspace_identities_workspace"`
	Source      string    `json:"source" gorm:"size:32;not null;default:toiv"`
	CreatedAt   time.Time `json:"createdAt"`
}

func (WorkspaceIdentity) TableName() string { return "workspace_identities" }
